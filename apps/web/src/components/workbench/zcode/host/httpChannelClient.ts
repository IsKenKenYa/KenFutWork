import {
  AGENT_GOVERNANCE_DEFAULTS,
  type CodeUiViewerScope,
  type CodeUiWorkspace,
  clampCodeUiReconnectDelayMs,
  codeUiWorkspaceSchema,
} from "@kenfutwork/shared";
import {
  Emitter,
  type Event,
  type IChannel,
  type IChannelClient,
  ProxyChannel,
} from "@zcode/rpc";
import {
  type IServiceAccessor,
  IWindowControllerService,
} from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";
import {
  type ClientHello,
  clientHelloSchema,
  windowHostControllerTaskFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { TaskWorkspaceRegistry } from "./taskWorkspaceRegistry.js";
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
    { path: string; references: number }
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
  setViewerContextResolver(resolve: (() => CodeUiViewerScope | null) | null) {
    this.viewerContext = resolve;
  }
  async openWorkspace(
    path: string,
    projectId?: string,
  ): Promise<CodeUiWorkspace> {
    await this.connect();
    const response = await this.request<{ result: CodeUiWorkspace }>(
      "/api/code-ui/rpc",
      {
        connectionId: this.connectionId,
        service: "workspace",
        method: "open",
        args: [{ path, ...(projectId ? { projectId } : {}) }],
      },
    );
    this.registerWorkspaces([response.result]);
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
      );
    return result as T;
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
          for (const key of this.workspaceSubscriptions.keys())
            this.notifications.fire({
              event: "service",
              service: "zcodeAgentService",
              name: "onAgentRuntimeRestarted",
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
    for (const [workspaceKey, { path }] of this.workspaceSubscriptions)
      this.notifications.fire({
        event: "service",
        service: "zcodeAgentService",
        name: "onAgentRuntimeLifecycle",
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

  private publishNotification(notification: Notification) {
    if (notification.event === "service") {
      const data = notification.data;
      if (data && typeof data === "object" && "taskMeta" in data)
        this.workspaces.registerTask(data.taskMeta);
      if (notification.service === IWindowControllerService.channelName) {
        const frame = windowHostControllerTaskFrameSchema.safeParse(data);
        if (frame.success) {
          const payload = frame.data.payload;
          const rows =
            payload.kind === "snapshot"
              ? payload.snapshot.tasks
              : payload.deltas.flatMap((delta) =>
                  delta.op === "task.upserted" ? [delta.task] : [],
                );
          for (const row of rows) this.workspaces.registerTask(row.meta);
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
    const value = values[0];
    if (!value || typeof value !== "object" || Array.isArray(value))
      return values;
    const first = value as Record<string, unknown>;
    const { task, project } = this.requestIdentity(first);
    if (task && project && method === "subscribeConversationV4")
      this.workspaces.selectProject(task.projectId, task.rootDirectory);
    const updated = { ...first };
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
      | { type?: string; payload?: Record<string, unknown> }
      | undefined;
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

  private injectViewer(service: string, method: string, values: unknown[]) {
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
      (service === ServiceChannels.FileWatcher && method === "watch") ||
      service === ServiceChannels.Skills;
    if (!viewerRequest) return values;
    const first = values[0] as Record<string, unknown> | undefined;
    if (first?.humanPurpose === "directory-picker") return values;
    const viewerScope = this.viewerContext?.();
    if (!viewerScope)
      throw new Error("请先选择 Code 项目或 Task 后使用工作区能力。");
    return [{ ...first, viewerScope }, ...values.slice(1)];
  }

  private async callChannel<TResult>(
    service: string,
    method: string,
    args?: unknown,
  ): Promise<TResult> {
    let values = args ?? [];
    if (Array.isArray(values))
      values = this.injectViewer(
        service,
        method,
        this.rewriteHostArguments(service, method, values),
      );
    await this.connect();
    if (
      service === "zcodeAgentService" &&
      method === "initializeConversationV4"
    )
      this.clientHello = clientHelloSchema.parse((values as unknown[])[0]);
    const connectionId = this.connectionId;
    const response = await this.request<{ result: TResult }>(
      "/api/code-ui/rpc",
      { connectionId, service, method, args: values },
    );
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
      for (const task of tasks) this.workspaces.registerTask(task);
    }
    let result = response.result;
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
    this.connected = false;
    this.ready?.reject(new DOMException("Code 宿主已关闭", "AbortError"));
    this.ready = null;
    this.notifications.dispose();
    this.servicesChanges.dispose();
    this.workspaceSubscriptions.clear();
    this.terminalListeners.clear();
    this.activatedTerminals.clear();
    this.ownedTerminals.clear();
  }
}
