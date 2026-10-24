import {
  AGENT_GOVERNANCE_DEFAULTS,
  type CodeGoalControl,
  type CodeGoalControlState,
  type CodeUiViewerScope,
  type CodeUiWorkspace,
  canvasDocumentUpdatedMessageSchema,
  clampCodeUiReconnectDelayMs,
  codeGoalControlStateSchema,
  codeProjectPreparedSessionSchema,
  codeProjectPrepareSessionArgsSchema,
  codeProjectTreeSchema,
  codeUiViewerScopeSchema,
  codeUiWorkspaceSchema,
  isPluginIconResourceReference,
  type ProjectDirectoryRelinkSnapshot,
  projectDirectoryRelinkResponseSchema,
  projectDirectoryRelinkSnapshotSchema,
} from "@kenfutwork/shared";
import {
  Emitter,
  type Event,
  type IChannel,
  type IChannelClient,
  ProxyChannel,
} from "@zcode/rpc";
import {
  IFileService,
  IFileWatcherService,
  IGitService,
  type IServiceAccessor,
  IWindowControllerService,
} from "@zcode/services";
import { ServiceChannels, zcodeTaskMetaSchema } from "@zcode/shared";
import {
  type ClientHello,
  clientHelloSchema,
  windowHostControllerTaskFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { registerCodeFileViewerClient } from "./fileViewerServices.js";
import {
  chooseDirectoryProject,
  confirmDirectoryRelink,
  DirectoryChoiceCancelledError,
} from "./ProjectDirectoryChoice.js";
import { notifyPluginInventoryChanged } from "./parentBridge.js";
import {
  captureTaskUnreadCall,
  readTaskUnreadResult,
} from "./taskUnreadRpc.js";
import {
  projectSupportsMode,
  TaskWorkspaceRegistry,
} from "./taskWorkspaceRegistry.js";
import { RemoteServiceAccess } from "./upstream/remoteServiceAccess.js";

export interface CodeHostConfig {
  apiBase: string;
  accessToken?: string;
  workspacePath?: string;
}
interface Notification {
  event: string;
  service?: string;
  name?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  data?: unknown;
  frame?: unknown;
  hello?: { connectionId: string };
  terminalId?: string;
  watcherId?: string;
  reconnectDelayMs?: number;
}

function notificationReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  return async (): Promise<Notification> => {
    for (;;) {
      const boundary = /\r?\n\r?\n/u.exec(buffer);
      if (!boundary) {
        const part = await reader.read();
        if (part.done) throw new Error("Code 通知通道已关闭");
        buffer += decoder.decode(part.value, { stream: true });
        continue;
      }
      const record = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = record
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) return JSON.parse(data) as Notification;
    }
  };
}

class CodeHostHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function reportAccessLost(status: number) {
  if (status !== 401 || window.parent === window) return;
  window.parent.postMessage(
    { type: "kenfutwork:code-access-lost" },
    window.location.origin,
  );
}

const servicesByChannel: Record<string, string> = {
  [ServiceChannels.ZCodeAgent]: "zcodeAgentService",
  [ServiceChannels.ModelSelection]: "modelSelectionService",
  [ServiceChannels.ProviderSettings]: "providerSettingsService",
};

function validateSkillsListResponse(result: unknown) {
  if (
    !result ||
    typeof result !== "object" ||
    !("skills" in result) ||
    !Array.isArray(result.skills) ||
    !("diagnostics" in result) ||
    !Array.isArray(result.diagnostics) ||
    !("capability" in result) ||
    !result.capability ||
    typeof result.capability !== "object" ||
    !("userScopeAvailable" in result.capability) ||
    typeof result.capability.userScopeAvailable !== "boolean" ||
    result.skills.some(
      (skill) =>
        !skill ||
        typeof skill !== "object" ||
        typeof skill.id !== "string" ||
        typeof skill.name !== "string" ||
        typeof skill.path !== "string" ||
        typeof skill.body !== "string" ||
        typeof skill.description !== "string" ||
        typeof skill.enabled !== "boolean" ||
        !["user", "workspace", "plugin"].includes(skill.scope),
    ) ||
    result.diagnostics.some(
      (diagnostic) =>
        !diagnostic ||
        typeof diagnostic !== "object" ||
        typeof diagnostic.code !== "string" ||
        !["warning", "error"].includes(diagnostic.severity) ||
        typeof diagnostic.message !== "string" ||
        (diagnostic.path !== undefined &&
          typeof diagnostic.path !== "string") ||
        (diagnostic.skillName !== undefined &&
          typeof diagnostic.skillName !== "string"),
    )
  )
    throw new Error("技能目录响应无效，请重新连接。");
}

/** ChannelClient 只替换载体；原 RemoteServiceAccess/ProxyChannel 保留服务和事件语义。 */
const viewerMethods = new Set([
  "readTextFile",
  "readFileRange",
  "readBinaryPreview",
  "readMediaPreview",
  "readdir",
  "stat",
  "checkFilesExist",
  "resolvePath",
  "searchWorkspaceFiles",
  "listWorkspaceFilesLength",
  "listWorkspaceFilesRange",
]);

export class CodeHttpChannelClient implements IChannelClient {
  private servicesSnapshot: IServiceAccessor = new RemoteServiceAccess(this);
  get services(): IServiceAccessor {
    return this.servicesSnapshot;
  }
  private readonly notifications = new Emitter<Notification>();
  private readonly pluginInventoryChanges = new Emitter<void>();
  readonly onPluginInventoryChanged = this.pluginInventoryChanges.event;
  private readonly servicesChanges = new Emitter<void>();
  readonly subscribeServices = (listener: () => void) => {
    const subscription = this.servicesChanges.event(listener);
    return () => subscription.dispose();
  };
  private readonly controller = new AbortController();
  private connectionId = "";
  private connected = false;
  private generation = 0;
  private clientHello: ClientHello | null = null;
  private reconnectDelayMs: number =
    AGENT_GOVERNANCE_DEFAULTS.codeUiReconnectDelayMs;
  private readonly workspaceSubscriptions = new Map<
    string,
    { path: string; workspaceIdentity?: string; references: number }
  >();
  private ready: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: unknown) => void;
  } | null = null;
  private running: Promise<void> | null = null;
  private fatalError: unknown;
  readonly workspaces = new TaskWorkspaceRegistry();
  private viewerContext: (() => CodeUiViewerScope | null) | null = null;
  private readonly terminalListeners = new Map<string, Map<string, number>>();
  private readonly activatedTerminals = new Set<string>();
  private readonly ownedTerminals = new Set<string>();
  private readonly goalStates = new Map<string, CodeGoalControlState["goal"]>();
  private readonly goalCommands = new Map<string, CodeGoalControl>();

  constructor(readonly config: CodeHostConfig) {
    const terminal = this.servicesSnapshot.terminalService;
    this.servicesSnapshot = {
      ...this.servicesSnapshot,
      terminalService: new Proxy(terminal, {
        get: (target, member) => {
          if (member !== "dispose") return Reflect.get(target, member);
          return (params: Parameters<typeof terminal.dispose>[0]) => {
            // 原RPC代理的async包装产生外层Promise，须在服务边界观察原void销毁回调。
            const operation = target.dispose(params);
            void operation.catch((error: unknown) => {
              if (
                this.controller.signal.aborted &&
                error &&
                typeof error === "object" &&
                "name" in error &&
                error.name === "AbortError"
              )
                return;
              console.error("Code终端关闭失败", error);
            });
            return operation;
          };
        },
      }),
    };
    registerCodeFileViewerClient(this);
  }

  registerWorkspaces(workspaces: CodeUiWorkspace[]) {
    this.workspaces.registerProjects(workspaces);
  }
  ownsTerminal(id: string): boolean {
    return this.ownedTerminals.has(id);
  }
  projectForPath(path: string, workspaceIdentity?: string | null) {
    return this.workspaces.projectForPath(path, workspaceIdentity);
  }
  async refreshWorkspaces() {
    const result = await this.request<{ workspaces: CodeUiWorkspace[] }>(
      "/api/code-ui/workspaces",
    );
    this.workspaces.replaceProjects(result.workspaces);
    return result.workspaces;
  }
  async directoryRelinkSnapshot(projectId: string) {
    try {
      return projectDirectoryRelinkSnapshotSchema.parse(
        await this.request(
          `/api/projects/${encodeURIComponent(projectId)}/relink-directory`,
        ),
      );
    } catch (error) {
      if (error instanceof CodeHostHttpError && error.status === 400)
        return null;
      throw error;
    }
  }
  async relinkDirectory(
    snapshot: ProjectDirectoryRelinkSnapshot,
    path: string,
  ) {
    let choice = await confirmDirectoryRelink(path, snapshot.projectId, {
      signal: this.controller.signal,
    });
    if (!choice) throw new DirectoryChoiceCancelledError();
    const submit = () =>
      this.request(
        `/api/projects/${encodeURIComponent(snapshot.projectId)}/relink-directory`,
        {
          expectedWorkDir: snapshot.workDir,
          nextWorkDir: path,
          expectedTasks: snapshot.tasks,
          ...(choice === "independent" ? { directoryChoice: choice } : {}),
        },
      );
    let result: unknown;
    try {
      result = await submit();
    } catch (error) {
      if (
        choice === "independent" ||
        !(error instanceof CodeHostHttpError) ||
        error.status !== 409 ||
        error.code !== "project_directory_conflict"
      )
        throw error;
      choice = await confirmDirectoryRelink(path, snapshot.projectId, {
        signal: this.controller.signal,
      });
      if (!choice) throw new DirectoryChoiceCancelledError();
      result = await submit();
    }
    return projectDirectoryRelinkResponseSchema.parse(result);
  }
  setWorkPresetResolver(resolve: () => "code" | "design") {
    this.workPreset = resolve;
  }
  currentWorkPreset() {
    return this.workPreset();
  }
  private workPreset: () => "code" | "design" = () => "code";
  setViewerContextResolver(resolve: (() => CodeUiViewerScope | null) | null) {
    this.viewerContext = resolve;
  }
  fileServicesForViewer(
    source: CodeUiViewerScope,
  ): Pick<
    IServiceAccessor,
    "fileService" | "fileWatcherService" | "gitService"
  > {
    const viewerScope = Object.freeze(codeUiViewerScopeSchema.parse(source));
    const channelFor = (channelName: string): IChannel => {
      const channel = this.getChannel<IChannel>(channelName);
      const service = servicesByChannel[channelName] ?? channelName;
      return {
        call: <TResult>(method: string, args?: unknown) =>
          this.callChannel<TResult>(service, method, args, viewerScope),
        listen: channel.listen,
      };
    };
    return {
      fileService: ProxyChannel.toService<IFileService>(
        channelFor(IFileService.channelName),
      ),
      fileWatcherService: ProxyChannel.toService<IFileWatcherService>(
        channelFor(IFileWatcherService.channelName),
      ),
      gitService: ProxyChannel.toService<IGitService>(
        channelFor(IGitService.channelName),
      ),
    };
  }
  async openWorkspace(
    path: string,
    projectId?: string,
    requestedPreset?: "code" | "design",
    shouldSelect: () => boolean = () => true,
  ): Promise<CodeUiWorkspace> {
    const preset = requestedPreset ?? this.workPreset();
    await this.connect();
    let independent = false;
    const select = async () => {
      const choice = await chooseDirectoryProject(path, preset, {
        signal: this.controller.signal,
      });
      if (!choice) throw new DirectoryChoiceCancelledError();
      if ("projectId" in choice) projectId = choice.projectId;
      else independent = "independent" in choice;
    };
    if (!projectId) await select();
    const submit = () =>
      this.request<{ result: CodeUiWorkspace }>("/api/code-ui/rpc", {
        connectionId: this.connectionId,
        service: "workspace",
        method: "open",
        args: [
          {
            path,
            ...(projectId ? { projectId } : {}),
            ...(independent ? { directoryChoice: "independent" } : {}),
            preset,
          },
        ],
      });
    let response: { result: CodeUiWorkspace };
    try {
      response = await submit();
    } catch (error) {
      if (
        projectId ||
        independent ||
        !(error instanceof CodeHostHttpError) ||
        error.status !== 409 ||
        error.code !== "project_directory_conflict"
      )
        throw error;
      await select();
      response = await submit();
    }
    this.registerWorkspaces([response.result]);
    if (shouldSelect())
      this.workspaces.selectProject(response.result.projectId);
    return response.result;
  }
  directoryServices(): IServiceAccessor {
    return {
      ...this.services,
      fileService: new Proxy(this.services.fileService, {
        get: (target, key) =>
          key === "readdir"
            ? (params: { path: string; includeHidden?: boolean }) =>
                target.readdir({
                  ...params,
                  humanPurpose: "directory-picker",
                } as typeof params)
            : Reflect.get(target, key),
      }),
    };
  }

  private headers(): Record<string, string> {
    return this.config.accessToken
      ? { authorization: `Bearer ${this.config.accessToken}` }
      : {};
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(
      `${this.config.apiBase.replace(/\/$/u, "")}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        signal: this.controller.signal,
        headers: {
          ...this.headers(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    reportAccessLost(response.status);
    const result = await response.json();
    if (!response.ok)
      throw new CodeHostHttpError(
        response.status,
        result.error?.message ?? `Code 宿主请求失败：${response.status}`,
        result.error?.code,
      );
    return result as T;
  }

  private readonly pluginIcons = new Map<string, Promise<string | undefined>>();
  private readonly pluginIconUrls = new Set<string>();
  async resolvePluginIcon(resource: string): Promise<string | undefined> {
    if (
      !isPluginIconResourceReference(resource) ||
      this.controller.signal.aborted
    )
      return undefined;
    const cached = this.pluginIcons.get(resource);
    if (cached) return cached;
    const pending = this.readHostImage(
      resource,
      this.controller.signal,
      [
        "image/svg+xml",
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/avif",
      ],
      "插件图标已不可用。",
    )
      .then((blob) => {
        if (this.controller.signal.aborted) return undefined;
        const image = URL.createObjectURL(blob);
        this.pluginIconUrls.add(image);
        return image;
      })
      .catch(() => {
        this.pluginIcons.delete(resource);
        return undefined;
      });
    this.pluginIcons.set(resource, pending);
    return pending;
  }

  async readCuaSnapshot(uri: string, signal: AbortSignal): Promise<Blob> {
    if (
      !/^\/api\/computer-use\/snapshots\?taskId=[0-9a-f-]{36}&digest=[0-9a-f]{64}$/u.test(
        uri,
      )
    )
      throw new Error("截图引用无效。");
    return this.readHostImage(uri, signal, ["image/png"], "截图已不可用。");
  }

  private async readHostImage(
    path: string,
    signal: AbortSignal,
    contentTypes: readonly string[],
    errorMessage: string,
  ): Promise<Blob> {
    const response = await fetch(
      `${this.config.apiBase.replace(/\/$/u, "")}${path}`,
      {
        credentials: "include",
        headers: this.headers(),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([signal, this.controller.signal]),
      },
    );
    reportAccessLost(response.status);
    if (
      !response.ok ||
      !contentTypes.includes(
        response.headers.get("content-type")?.split(";")[0] ?? "",
      )
    ) {
      await response.body?.cancel();
      throw new CodeHostHttpError(response.status, errorMessage);
    }
    return response.blob();
  }

  /**
   * 语音转写（语音助手「听」段）：multipart WAV → `{ text }`。
   * 与 `request` 分开：multipart 不能带 JSON content-type（boundary 交给浏览器）。
   */
  async transcribeVoice(wav: Uint8Array): Promise<string> {
    const form = new FormData();
    // 复制到独立 ArrayBuffer：BlobPart 不接受 ArrayBufferLike（可能为 SharedArrayBuffer）口径
    form.append(
      "file",
      new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
      "audio.wav",
    );
    const response = await fetch(
      `${this.config.apiBase.replace(/\/$/u, "")}/api/voice/transcribe`,
      {
        method: "POST",
        credentials: "include",
        signal: this.controller.signal,
        headers: this.headers(),
        body: form,
      },
    );
    reportAccessLost(response.status);
    const result = (await response.json()) as {
      text?: string;
      error?: { message?: string };
    };
    if (!response.ok)
      throw new CodeHostHttpError(
        response.status,
        result.error?.message ?? `语音转写失败：${response.status}`,
      );
    return result.text ?? "";
  }

  /**
   * 语音播报（语音助手「说」段）：文本 → 音频字节。响应体是二进制（不是 JSON），
   * 故与 `request` 分开；打断通过在途 signal 中止。
   */
  async speakVoice(input: {
    text: string;
    signal: AbortSignal;
  }): Promise<Blob> {
    const response = await fetch(
      `${this.config.apiBase.replace(/\/$/u, "")}/api/voice/speak`,
      {
        method: "POST",
        credentials: "include",
        signal: input.signal,
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ text: input.text }),
      },
    );
    reportAccessLost(response.status);
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new CodeHostHttpError(
        response.status,
        result?.error?.message ?? `语音播报失败：${response.status}`,
      );
    }
    return await response.blob();
  }

  connect(): Promise<void> {
    if (this.controller.signal.aborted)
      return Promise.reject(new DOMException("Code 宿主已关闭", "AbortError"));
    if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
    if (this.connected) return Promise.resolve();
    const ready = this.prepareReady();
    this.running ??= this.consumeConnections().catch((error: unknown) => {
      this.fatalError = error;
      this.ready?.reject(error);
      this.ready = null;
    });
    return ready.promise;
  }

  private prepareReady() {
    if (!this.ready) {
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void promise.catch(() => {});
      this.ready = { promise, resolve, reject };
    }
    return this.ready;
  }

  private async openNotifications() {
    const response = await fetch(
      `${this.config.apiBase.replace(/\/$/u, "")}/api/code-ui/events`,
      {
        headers: this.headers(),
        credentials: "include",
        signal: this.controller.signal,
      },
    );
    reportAccessLost(response.status);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new CodeHostHttpError(
        response.status,
        `Code 通知通道不可用：${response.status}`,
      );
    }
    const reader = response.body.getReader();
    return { reader, read: notificationReader(reader) };
  }

  private async consumeConnections() {
    while (!this.controller.signal.aborted) {
      let stream:
        | Awaited<ReturnType<CodeHttpChannelClient["openNotifications"]>>
        | undefined;
      try {
        stream = await this.openNotifications();
        const initial = await stream.read();
        if (initial.event !== "ready" || !initial.hello?.connectionId)
          throw new Error("Code 宿主缺少原协议 hello");
        this.connectionId = initial.hello.connectionId;
        if (initial.reconnectDelayMs !== undefined)
          this.reconnectDelayMs = clampCodeUiReconnectDelayMs(
            initial.reconnectDelayMs,
          );
        const restoring = this.generation > 0;
        this.generation += 1;
        if (restoring) await this.restoreServices();
        this.connected = true;
        this.ready?.resolve();
        this.ready = null;
        if (restoring) {
          // Controller 租约随通知连接释放；原 registry 由代理身份换代触发重订阅。
          this.servicesSnapshot = {
            ...this.servicesSnapshot,
            windowControllerService:
              ProxyChannel.toService<IWindowControllerService>(
                this.getChannel(IWindowControllerService.channelName),
              ),
          };
          this.servicesChanges.fire();
          // 实例项目与分组可能在断线期间改变；沿原失效通知重读，保留当前编辑意图。
          for (const channel of ["state:projects", "state:task-groups"])
            this.notifications.fire({
              event: "service",
              service: ServiceChannels.Broadcast,
              name: "onMessage",
              data: { channel, payload: {} },
            });
          for (const [key, scope] of this.workspaceSubscriptions)
            this.notifications.fire({
              event: "service",
              service: "zcodeAgentService",
              name: "onAgentRuntimeRestarted",
              workspacePath: scope.path,
              ...(scope.workspaceIdentity
                ? { workspaceIdentity: scope.workspaceIdentity }
                : {}),
              data: { workspaceKey: key },
            });
          this.publishLifecycle("available");
        }
        while (!this.controller.signal.aborted)
          this.publishNotification(await stream.read());
      } catch (error) {
        if (this.controller.signal.aborted) return;
        if (this.connected) {
          this.connected = false;
          this.prepareReady();
          this.publishLifecycle("unavailable");
        }
        this.connectionId = "";
        this.goalStates.clear();
        if (
          error instanceof CodeHostHttpError &&
          (error.status === 401 || error.status === 403)
        )
          throw error;
        await this.waitToReconnect();
      } finally {
        if (stream) {
          await stream.reader.cancel().catch(() => {});
          stream.reader.releaseLock();
        }
      }
    }
  }

  private async restoreServices() {
    if (this.clientHello)
      await this.request("/api/code-ui/rpc", {
        connectionId: this.connectionId,
        service: "zcodeAgentService",
        method: "initializeConversationV4",
        args: [this.clientHello],
      });
    for (const service of [
      "providerSettingsService",
      "modelSelectionService",
    ]) {
      const view = await this.request<{ result: unknown }>("/api/code-ui/rpc", {
        connectionId: this.connectionId,
        service,
        method: "getView",
        args: [],
      });
      this.notifications.fire({
        event: "service",
        service,
        name: "onDidChange",
        data: view.result,
      });
    }
  }

  private publishLifecycle(state: "available" | "unavailable") {
    for (const [workspaceKey, { path, workspaceIdentity }] of this
      .workspaceSubscriptions)
      this.notifications.fire({
        event: "service",
        service: "zcodeAgentService",
        name: "onAgentRuntimeLifecycle",
        workspacePath: path,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        data: {
          workspaceKey,
          workspacePath: path,
          state,
          runtimeIdentity: {
            workspaceKey,
            generation: this.generation,
            identity: this.connectionId,
          },
        },
      });
  }

  private waitToReconnect() {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, this.reconnectDelayMs);
      this.controller.signal.addEventListener("abort", finish, { once: true });
      if (this.controller.signal.aborted) finish();
    });
  }

  private registerTaskProjection(value: unknown) {
    const task = zcodeTaskMetaSchema.parse(value);
    if (!task.projectId || !task.workspaceIdentity) {
      this.workspaces.registerTask(task);
      return;
    }
    this.workspaces.applyProjectTask({
      taskId: task.taskId,
      projectId: task.projectId,
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
      ...(task.taskControl ? { taskControl: task.taskControl } : {}),
      ...(task.conversationRevision === undefined
        ? {}
        : { conversationRevision: task.conversationRevision }),
    });
  }

  private publishNotification(notification: Notification) {
    if (this.controller.signal.aborted) return;
    if (notification.event === "canvasDocumentUpdated") {
      const message = canvasDocumentUpdatedMessageSchema.safeParse(
        notification.data,
      );
      if (!message.success) return;
      window.dispatchEvent(
        new CustomEvent(
          message.data.deleted
            ? "kenfutwork:document-deleted"
            : "kenfutwork:document-updated",
          { detail: message.data },
        ),
      );
    }
    if (notification.event === "service") {
      const data = notification.data;
      if (
        notification.service === "zcodeAgentService" &&
        notification.name === "onGoalControlState"
      ) {
        const state = codeGoalControlStateSchema.safeParse(data);
        if (state.success)
          this.goalStates.set(state.data.taskId, state.data.goal);
      }
      if (
        notification.service === ServiceChannels.ZCodeTask &&
        notification.name === "onDynamicWorkspaceEvent" &&
        data &&
        typeof data === "object" &&
        "type" in data &&
        data.type === "workspace_task_list_changed" &&
        "taskMeta" in data &&
        data.taskMeta !== undefined
      )
        this.registerTaskProjection(data.taskMeta);
      if (
        notification.service === IWindowControllerService.channelName &&
        notification.name === "onDynamicControllerFrame"
      ) {
        const frame = windowHostControllerTaskFrameSchema.safeParse(data);
        if (frame.success) {
          const payload = frame.data.payload;
          const rows =
            payload.kind === "snapshot"
              ? payload.snapshot.tasks
              : payload.deltas.flatMap((delta) =>
                  delta.op === "task.upserted" ? [delta.task] : [],
                );
          for (const row of rows) this.registerTaskProjection(row.meta);
        }
      }
    }
    this.notifications.fire(notification);
  }

  private requestIdentity(first: Record<string, unknown>) {
    const envelope = first.envelope as { sessionId?: unknown } | undefined;
    let taskId: string | null = null;
    if (typeof first.taskId === "string") taskId = first.taskId;
    else if (typeof first.sessionId === "string") taskId = first.sessionId;
    else if (typeof envelope?.sessionId === "string")
      taskId = envelope.sessionId;
    const task = taskId ? this.workspaces.task(taskId) : null;
    const path =
      typeof first.workspacePath === "string" ? first.workspacePath : null;
    const project = task
      ? this.workspaces.defaultFor(task.rootDirectory, task.taskId)
      : path
        ? this.projectForPath(
            path,
            typeof first.workspaceIdentity === "string"
              ? first.workspaceIdentity
              : undefined,
          )
        : null;
    return { task, project };
  }

  private rewriteHostArguments(
    service: string,
    method: string,
    values: unknown[],
  ) {
    if (
      service === ServiceChannels.ZCodeTask &&
      [
        "archiveTask",
        "unarchiveTask",
        "deleteArchivedTask",
        "setTaskUnread",
      ].includes(method)
    )
      return values;
    const value = values[0];
    if (!value || typeof value !== "object" || Array.isArray(value))
      return values;
    const first = value as Record<string, unknown>;
    const { task, project } = this.requestIdentity(first);
    if (task && project && method === "subscribeConversationV4")
      this.workspaces.selectProject(task.projectId, task.rootDirectory);
    const updated = { ...first };
    if (service === ServiceChannels.Project && method === "prepareSession")
      updated.preset = first.preset ?? this.workPreset();
    if (task && typeof first.workspacePath === "string") {
      updated.workspacePath = task.rootDirectory;
      if (typeof first.workspaceIdentity === "string")
        updated.workspaceIdentity = this.workspaces.identityFor(
          task.projectId,
          task.rootDirectory,
        );
    }
    if (
      project &&
      (service === ServiceChannels.ZCodeTask ||
        service === ServiceChannels.ZCodeSession ||
        service === "zcodeAgentService" ||
        method === "subscribeSessionsIndexV4")
    )
      updated.projectId = project.projectId;
    const command = first.envelope as
      | {
          type?: string;
          sessionId?: string;
          clientId?: string;
          commandId?: string;
          payload?: Record<string, unknown>;
        }
      | undefined;
    if (
      method === "sendConversationCommandV4" &&
      ["sendGoalCommand", "resumeGoal", "pauseGoal"].includes(
        command?.type ?? "",
      ) &&
      first.goalControl === undefined
    ) {
      const key = JSON.stringify([
        command?.sessionId,
        command?.clientId,
        command?.commandId,
      ]);
      let control = this.goalCommands.get(key);
      if (!control) {
        if (!command?.sessionId || !this.goalStates.has(command.sessionId))
          throw new Error("目标状态尚未同步，请重新连接后重试。");
        control = { expectedGoal: this.goalStates.get(command.sessionId)! };
        this.goalCommands.set(key, structuredClone(control));
      }
      updated.goalControl = structuredClone(control);
    }
    if (command?.type === "createSession") {
      let selected = project;
      if (!selected && typeof command.payload?.workspaceId === "string")
        selected = this.projectForPath(command.payload.workspaceId);
      if (!selected)
        throw new Error("创建 Code Task 需要明确的项目身份，请重新选择项目。");
      updated.envelope = {
        ...command,
        payload: { ...command.payload, workspaceId: selected.projectId },
      };
    }
    return [updated, ...values.slice(1)];
  }

  private injectViewer(
    service: string,
    method: string,
    values: unknown[],
    fixedViewer?: CodeUiViewerScope,
  ) {
    if (service === ServiceChannels.Terminal && method === "create") {
      const scope = this.viewerContext?.();
      if (scope?.kind !== "task")
        throw new Error("请先创建或选择Code Task后打开终端。");
      return [
        { ...(values[0] as object), taskId: scope.taskId },
        ...values.slice(1),
      ];
    }
    const viewerRequest =
      (service === ServiceChannels.File && viewerMethods.has(method)) ||
      service === ServiceChannels.Git ||
      (service === ServiceChannels.FileWatcher && method === "watch");
    if (!viewerRequest) return values;
    const first = values[0] as Record<string, unknown> | undefined;
    if (!fixedViewer && first?.humanPurpose === "directory-picker")
      return values;
    const viewerScope = fixedViewer ?? this.viewerContext?.();
    if (!viewerScope)
      throw new Error("请先选择 Code 项目或 Task 后使用工作区能力。");
    const request: Record<string, unknown> = { ...first, viewerScope };
    if (fixedViewer) delete request.humanPurpose;
    return [request, ...values.slice(1)];
  }

  private async callChannel<TResult>(
    service: string,
    method: string,
    args?: unknown,
    fixedViewer?: CodeUiViewerScope,
  ): Promise<TResult> {
    let values = args ?? [];
    if (Array.isArray(values))
      values = this.injectViewer(
        service,
        method,
        this.rewriteHostArguments(service, method, values),
        fixedViewer,
      );
    const unreadCall = captureTaskUnreadCall(service, method, values);
    if (unreadCall) values = unreadCall.args;
    await this.connect();
    if (
      service === "zcodeAgentService" &&
      method === "initializeConversationV4"
    )
      this.clientHello = clientHelloSchema.parse((values as unknown[])[0]);
    const connectionId = this.connectionId;
    let response: { result: TResult };
    try {
      response = await this.request<{ result: TResult }>("/api/code-ui/rpc", {
        connectionId,
        service,
        method,
        args: values,
      });
    } finally {
      // 未知写入结果同样读取库存对账；不重试写操作。
      if (
        service === ServiceChannels.PluginManagement &&
        [
          "installPlugin",
          "installPluginFromSource",
          "setPluginEnabled",
          "uninstallPlugin",
        ].includes(method)
      ) {
        this.pluginInventoryChanges.fire();
        notifyPluginInventoryChanged();
      }
    }
    if (unreadCall) {
      if (this.controller.signal.aborted || connectionId !== this.connectionId)
        throw new Error("任务更新期间连接已改变，请重新加载列表。");
      return readTaskUnreadResult(unreadCall, response.result) as TResult;
    }
    if (service === ServiceChannels.Project && method === "readTree") {
      if (this.controller.signal.aborted || connectionId !== this.connectionId)
        throw new Error("项目读取期间连接已改变，请重新加载项目。");
      const tree = codeProjectTreeSchema.parse(response.result);
      for (const task of tree.tasks) this.workspaces.applyProjectTask(task);
      return tree as TResult;
    }
    if (service === ServiceChannels.Project && method === "prepareSession") {
      const [intent] = codeProjectPrepareSessionArgsSchema.parse(values);
      const prepared = codeProjectPreparedSessionSchema.parse(response.result);
      if (prepared.projectId !== intent.projectId)
        throw new Error("项目准备结果不一致，请重新选择项目。");
      const project = (await this.refreshWorkspaces()).find(
        (entry) => entry.projectId === prepared.projectId,
      );
      if (
        !project ||
        project.path !== prepared.workspacePath ||
        this.workspaces.identityFor(project.projectId, project.path) !==
          prepared.workspaceIdentity
      )
        throw new Error("项目目录已改变，请重新选择项目。");
      if (!projectSupportsMode(project, intent.preset))
        throw new Error("项目工作方式已改变，请重新选择项目。");
    }
    if (service === ServiceChannels.Terminal && method === "create") {
      if (this.controller.signal.aborted || connectionId !== this.connectionId)
        throw new Error("终端启动期间通知连接已改变，请重新打开终端。");
      const terminal = response.result;
      if (
        terminal &&
        typeof terminal === "object" &&
        "id" in terminal &&
        typeof terminal.id === "string"
      )
        this.ownedTerminals.add(terminal.id);
    }
    if (
      service === ServiceChannels.ZCodeTask ||
      service === IWindowControllerService.channelName
    ) {
      if (this.controller.signal.aborted || connectionId !== this.connectionId)
        throw new Error("任务读取期间连接已改变，请重新加载任务。");
      const value = response.result;
      const tasks =
        value &&
        typeof value === "object" &&
        "items" in value &&
        Array.isArray(value.items)
          ? value.items
          : Array.isArray(value)
            ? value
            : [value];
      for (const task of tasks) {
        const candidate =
          task && typeof task === "object" && "meta" in task ? task.meta : task;
        const parsed = zcodeTaskMetaSchema.safeParse(candidate);
        if (parsed.success) this.registerTaskProjection(parsed.data);
        else this.workspaces.registerTask(candidate);
      }
    }
    let result = response.result;
    if (service === ServiceChannels.Skills && method === "list")
      validateSkillsListResponse(result);
    if (
      service === ServiceChannels.File &&
      [
        "ensureConversationWorkspace",
        "createDefaultWorkspace",
        "createScratchWorkspace",
      ].includes(method)
    ) {
      const workspace = codeUiWorkspaceSchema.parse(result);
      this.registerWorkspaces([workspace]);
      this.workspaces.selectProject(workspace.projectId);
      result = {
        ...result,
        workspaceIdentity: this.workspaces.identityFor(
          workspace.projectId,
          workspace.path,
        ),
      } as TResult;
    }
    if (
      method === "readFileRange" &&
      result &&
      typeof result === "object" &&
      "encoding" in result &&
      result.encoding === "base64" &&
      "data" in result &&
      typeof result.data === "string"
    ) {
      return Uint8Array.from(atob(result.data), (character) =>
        character.charCodeAt(0),
      ) as TResult;
    }
    return result;
  }

  getChannel<TChannel extends IChannel>(channelName: string): TChannel {
    const service = servicesByChannel[channelName] ?? channelName;
    const channel: IChannel = {
      call: <TResult>(method: string, args?: unknown) =>
        this.callChannel<TResult>(service, method, args),
      listen:
        <TResult>(event: string, scope?: unknown): Event<TResult> =>
        (listener) => {
          const terminalId =
            service === ServiceChannels.Terminal && typeof scope === "string"
              ? scope
              : undefined;
          const watcherId =
            service === ServiceChannels.FileWatcher && typeof scope === "string"
              ? scope
              : undefined;
          const target =
            scope && typeof scope === "object"
              ? (scope as {
                  workspacePath?: string;
                  workspaceIdentity?: string;
                })
              : undefined;
          const workspacePath = target?.workspacePath;
          const workspaceKey = workspacePath
            ? target?.workspaceIdentity?.trim() || workspacePath
            : undefined;
          if (workspacePath && workspaceKey) {
            const reference = this.workspaceSubscriptions.get(workspaceKey) ?? {
              path: workspacePath,
              ...(target?.workspaceIdentity
                ? { workspaceIdentity: target.workspaceIdentity }
                : {}),
              references: 0,
            };
            reference.references += 1;
            this.workspaceSubscriptions.set(workspaceKey, reference);
          }
          const subscription = this.notifications.event((notification) => {
            if (workspacePath && workspacePath !== notification.workspacePath)
              return;
            if (
              target?.workspaceIdentity &&
              target.workspaceIdentity !== notification.workspaceIdentity
            )
              return;
            if (terminalId && notification.terminalId !== terminalId) return;
            if (watcherId && notification.watcherId !== watcherId) return;
            if (notification.event === "service") {
              if (
                notification.service === service &&
                notification.name === event
              )
                listener(notification.data as TResult);
            } else if (notification.event === event)
              listener(notification.frame as TResult);
          });
          if (terminalId) {
            const registered =
              this.terminalListeners.get(terminalId) ??
              new Map<string, number>();
            registered.set(event, (registered.get(event) ?? 0) + 1);
            this.terminalListeners.set(terminalId, registered);
            // 原TerminalService先data后exit同步挂监听；下一微任务才启服务端输出。
            queueMicrotask(() => {
              if (
                this.controller.signal.aborted ||
                this.activatedTerminals.has(terminalId) ||
                !registered.get("onDynamicData") ||
                !registered.get("onDynamicExit")
              )
                return;
              this.activatedTerminals.add(terminalId);
              void this.callChannel(ServiceChannels.Terminal, "activate", [
                { id: terminalId },
              ]).catch((error: unknown) => {
                this.activatedTerminals.delete(terminalId);
                console.error("Code终端输出激活失败", error);
              });
            });
          }
          let disposed = false;
          return {
            dispose: () => {
              if (disposed) return;
              disposed = true;
              subscription.dispose();
              if (workspaceKey) {
                const reference = this.workspaceSubscriptions.get(workspaceKey);
                if (reference && --reference.references === 0)
                  this.workspaceSubscriptions.delete(workspaceKey);
              }
              if (terminalId) {
                const registered = this.terminalListeners.get(terminalId);
                if (registered) {
                  registered.set(
                    event,
                    Math.max(0, (registered.get(event) ?? 0) - 1),
                  );
                }
              }
            },
          };
        },
    };
    return channel as TChannel;
  }

  dispose() {
    this.controller.abort();
    for (const image of this.pluginIconUrls) URL.revokeObjectURL(image);
    this.pluginIconUrls.clear();
    this.pluginIcons.clear();
    this.connected = false;
    this.ready?.reject(new DOMException("Code 宿主已关闭", "AbortError"));
    this.ready = null;
    this.notifications.dispose();
    this.pluginInventoryChanges.dispose();
    this.servicesChanges.dispose();
    this.workspaceSubscriptions.clear();
    this.terminalListeners.clear();
    this.activatedTerminals.clear();
    this.ownedTerminals.clear();
    this.goalStates.clear();
    this.goalCommands.clear();
  }
}
