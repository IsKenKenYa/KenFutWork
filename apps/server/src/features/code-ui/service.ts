import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type CodeExecutionScope,
  type CodeUiEvent,
  type CodeUiWorkspace,
  codeUiControllerTaskListQuerySchema,
  zcodeUiProtocol as protocol,
  type StreamEvent,
} from "@kenfutwork/shared";
import {
  appSettingsSchema,
  resolveExecutionState,
  zcodeWorkspacePresentationSchema,
} from "@zcode/shared";
import type { AgentRunService } from "../../agent/runtime.js";
import { DEFAULT_SANDBOX_ROOT } from "../../agent/sandbox-dir.js";
import type { ServerEnv } from "../../config/env.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import type { AgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import type { BlobStore } from "../blob/types.js";
import type { ThreadService } from "../chat/thread-service.js";
import type { CheckpointService } from "../checkpoints/checkpoint-service.js";
import { createScopedGitExec } from "../code-git/scoped-git-exec.js";
import type {
  ChildSession,
  CodeChildRequest,
} from "../code-subagents/types.js";
import type { CodeTerminalService } from "../code-terminal/types.js";
import { codeUiTerminalRpc } from "../code-terminal/ui-rpc.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import {
  ExecutionScopeError,
  type ExecutionScopes,
  resolveReadOnlyProjectPath,
} from "../execution/scope-service.js";
import { forgetTaskFileState } from "../execution/scoped-filesystem.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ModelCatalogService } from "../model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import type { ApprovalEvent } from "../permissions/approval-types.js";
import type { PermissionService } from "../permissions/permission-service.js";
import type { PluginRegistryService } from "../plugins/plugin-registry-service.js";
import type { ProcessSandbox } from "../process-sandbox/types.js";
import type { ProjectService } from "../projects/project-service.js";
import { resolveProjectWorkDirectory } from "../projects/work-dir.js";
import type { SettingsService } from "../settings/settings-service.js";
import type {
  InstanceSkillSettingsRepository,
  SkillCatalogRepository,
} from "../skills/repository.js";
import type {
  TaskWorkContext,
  TaskWorkManager,
  TaskWorkRecord,
} from "../task-work/types.js";
import { createCodeAttachmentHost } from "./attachments/host.js";
import type { TrustedCodeInput } from "./attachments/input-types.js";
import { codeAttachmentsRpc, isCodeAttachmentRpc } from "./attachments/rpc.js";
import type {
  CodeAttachmentRepository,
  CodeAttachmentsService,
} from "./attachments/types.js";
import { CodeAttachmentError } from "./attachments/types.js";
import { CodeUiConnections } from "./connections.js";
import { createCodeUiWindowController } from "./controller-host.js";
import { createCodeUiConversation } from "./conversation.js";
import {
  collectTurnFileChanges,
  requireFileChangesTarget,
} from "./file-changes.js";
import { createCodeUiFileHistory } from "./file-history.js";
import { CodeUiFileIndex, codeUiViewerRpc } from "./files.js";
import { createCodeUiHistoryEdit } from "./history-edit.js";
import { createCodeGuideInputs } from "./guide-input.js";
import { createCodePlanningControl } from "./planning-control.js";
import { createCodeApprovedPlanStore } from "./approved-plan-store.js";
import { createCodeApprovedPlanReader } from "./approved-plan-reader.js";
import type { PromptExecutionContext } from "../../kernel/types.js";
import { createCodeUiFileWatchers } from "./host-file-watcher.js";
import {
  type CodeUiHostGitRpc,
  createCodeUiHostGitRpc,
} from "./host-git-rpc.js";
import {
  type CodeUiHostServicesRpc,
  type CodeUiHostTargetRequest,
  createCodeUiHostServicesRpc,
} from "./host-service-rpc.js";
import type { CodeAdmittedInput } from "./input-intents.js";
import { compileCodeUiModelExecution } from "./model-execution-options.js";
import { createCodeUiPluginsHost } from "./plugins.js";
import {
  type CodeUiProviderSettingsRpc,
  createCodeUiProviderSettingsRpc,
} from "./provider-settings-rpc.js";
import type { CodeInputSettlement } from "./queue-control.js";
import { applyCodeQueueCommand, CODE_QUEUE_COMMANDS, codeInputRouting } from "./queue-control.js";
import { type CodeUiRepository, CodeUiRepositoryError } from "./repository.js";
import { codeUiTaskMeta } from "./task-index.js";
import type {
  CodeUserInputService,
  UserInputEvent,
  UserInputResolutionResult,
} from "./user-input-types.js";
import {
  type CodeUiWorkspaceConfigRequest,
  type CodeUiWorkspaceConfigTarget,
  createCodeUiWorkspaceConfigHost,
} from "./workspace-config.js";
import {
  createHumanWorkspaceRpc,
  type HumanWorkspaceRpc,
} from "./workspace-rpc.js";

export interface CodeUiServiceDeps {
  plugins?: PluginRegistryService;
  checkpoints?: CheckpointService;
  permissions?: PermissionService;
  userInputs?: CodeUserInputService;
  terminals?: CodeTerminalService;
  blob?: BlobStore;
  attachmentRepository?: CodeAttachmentRepository;
  skillRepository?: SkillCatalogRepository;
  skillSettingsRepository?: InstanceSkillSettingsRepository;
  processSandbox?: ProcessSandbox;
  beforeCloseTask?: (
    actor: LocalActor,
    taskId: string,
    reason: "archive" | "delete" | "branch",
  ) => Promise<void>;
  repository: CodeUiRepository;
  executionScopes: ExecutionScopes;
  localInstance: LocalInstanceService;
  projects: ProjectService;
  modelProviders: ModelProviderService;
  modelCatalog: ModelCatalogService;
  settings: SettingsService;
  threads: ThreadService;
  agentRuns: AgentRunService;
  agentRunMetadata: AgentRunMetadataService;
  env: ServerEnv;
  taskWork: TaskWorkManager;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function requireLiveUserInput(
  root: NonNullable<Awaited<ReturnType<CodeUiRepository["find"]>>>,
  event: ApprovalEvent | UserInputEvent,
) {
  const ownerId =
    event.identity.agentId === "main" ? root.id : event.identity.agentId;
  const owner = root.state?.snapshots.find(
    (snapshot) => snapshot.sessionId === ownerId,
  );
  if (
    root.deleted_at ||
    root.archived ||
    root.execution_state !== "ready" ||
    Number(root.scope_generation) !== event.identity.scopeGeneration ||
    Number(root.branch_generation) !== event.identity.branchGeneration ||
    owner?.control.phase !== "running" ||
    !owner.control.activeWorks.some(
      (work) => work.foregroundExecutionId === event.identity.runId,
    ) ||
    (event.identity.planningEpoch !== undefined &&
      (event.identity.planningEpoch !== (root.state?.planningEpoch ?? 0) ||
        root.active_run_id !== event.identity.runId || owner.config.planEnabled !== true))
  )
    throw new CodeUiRepositoryError(
      "command_conflict",
      "提问所属运行或 Task 代际已失效",
    );
}

function publishOnce(operation: () => Promise<void>): () => Promise<void> {
  let publication: Promise<void> | undefined;
  return () => (publication ??= operation());
}

export function codeUiCommandFingerprint(
  envelope: protocol.CommandEnvelope,
): string {
  return createHash("sha256")
    .update(
      canonical({
        sessionId: envelope.sessionId,
        type: envelope.type,
        payload: envelope.payload,
      }),
    )
    .digest("hex");
}

/** 服务定义的具体 Provider；原 GUI 仅调用该域提供的 RPC/会话消费接口。 */
export class CodeUiService {
  private readonly guideInputs: ReturnType<typeof createCodeGuideInputs>;
  private readonly planning: ReturnType<typeof createCodePlanningControl>;
  private readonly approvedPlans: ReturnType<typeof createCodeApprovedPlanReader>;
  readonly userInputs: CodeUserInputService | undefined;
  private readonly connections = new CodeUiConnections();
  private readonly controllers = new Map<
    string,
    {
      instanceId: string;
      host: ReturnType<typeof createCodeUiWindowController>;
    }
  >();
  private readonly taskActors = new Map<string, LocalActor>();
  private readonly humanWorkspace: HumanWorkspaceRpc;
  private readonly providerSettings: CodeUiProviderSettingsRpc;
  private readonly attachments: CodeAttachmentsService | undefined;
  private readonly hostServices: CodeUiHostServicesRpc | undefined;
  private readonly watchers: ReturnType<typeof createCodeUiFileWatchers>;
  private readonly git: CodeUiHostGitRpc | undefined;
  private closing = false;
  private attachmentsUsed = false;
  private readonly inputOwner: { hostId: string; runtimeId: string };
  private initialization: Promise<void> | undefined;
  private readonly fileIndexes = new WeakMap<object, CodeUiFileIndex>();
  private readonly fileHistory: ReturnType<typeof createCodeUiFileHistory>;
  private readonly historyEdit: ReturnType<typeof createCodeUiHistoryEdit>;
  private readonly workspaceConfig: ReturnType<
    typeof createCodeUiWorkspaceConfigHost
  >;
  private readonly plugins:
    | ReturnType<typeof createCodeUiPluginsHost>
    | undefined;
  constructor(private readonly deps: CodeUiServiceDeps) {
    const files = createCodeApprovedPlanStore();
    this.approvedPlans = createCodeApprovedPlanReader({
      repository: deps.repository, localInstance: deps.localInstance, settings: deps.settings, files,
    });
    this.planning = createCodePlanningControl({
      repository: deps.repository,
      localInstance: deps.localInstance,
      files,
      refresh: (instanceId, path, projectId) =>
        this.refreshTaskProjection(instanceId, path, projectId),
    });
    this.guideInputs = createCodeGuideInputs({
      repository: deps.repository,
      refresh: (instanceId, path, projectId) => this.refreshTaskProjection(instanceId, path, projectId),
    });
    this.userInputs = deps.userInputs;
    this.inputOwner = {
      hostId: createHash("sha256")
        .update(resolve(deps.env.checkpointRoot ?? "data/checkpoints"))
        .digest("hex"),
      runtimeId: randomUUID(),
    };
    this.fileHistory = createCodeUiFileHistory({
      repository: deps.repository,
      executionScopes: deps.executionScopes,
      agentRunMetadata: deps.agentRunMetadata,
      settings: deps.settings,
      ...(deps.checkpoints ? { checkpoints: deps.checkpoints } : {}),
      ...(deps.processSandbox ? { processSandbox: deps.processSandbox } : {}),
      load: (actor, sessionId) => this.loadConversation(actor, sessionId),
      beginRestore: (scope, actor, guard) =>
        this.rewindTask(
          actor,
          scope.describe().taskId,
          scope.describe().generation,
          guard,
        ),
      finishRestore: (scope, actor, success) =>
        this.finishTaskRestore(scope, actor, success),
      refresh: (instanceId, path, projectId) =>
        this.refreshTaskProjection(instanceId, path, projectId),
      fingerprint: codeUiCommandFingerprint,
    });
    this.historyEdit = createCodeUiHistoryEdit({
      repository: deps.repository,
      agentRuns: deps.agentRuns,
      agentRunMetadata: deps.agentRunMetadata,
      threads: deps.threads,
      inputOwner: this.inputOwner,
      load: (actor, sessionId) => this.loadConversation(actor, sessionId),
      model: (actor, selection) => this.prepareInputModel(actor, selection),
      inputs: async (actor, sessionId, attachments) => {
        if (!attachments.length) return [];
        if (!this.attachments)
          throw new CodeAttachmentError(
            "fault.attachment.unavailable",
            "Code附件存储不可用。",
            503,
          );
        this.attachmentsUsed = true;
        return this.attachments.readForInput(actor, sessionId, attachments);
      },
      beginRestore: (actor, taskId, generation, guard) =>
        this.rewindTask(actor, taskId, generation, guard),
      finishRestore: (scope, actor, success) =>
        this.finishTaskRestore(scope, actor, success),
      refresh: (instanceId, path, projectId) =>
        this.refreshTaskProjection(instanceId, path, projectId),
      run: (actor, project, taskId, threadId, record, inputs) =>
        this.runTurn(
          actor,
          project,
          taskId,
          threadId,
          record.runId,
          record.intent.text,
          `${record.intent.modelSelection!.providerId}:${record.intent.modelSelection!.modelId}`,
          record.modelInvocation,
          inputs,
        ),
      fingerprint: codeUiCommandFingerprint,
    });
    this.workspaceConfig = createCodeUiWorkspaceConfigHost({
      connections: this.connections,
      resolveTarget: (actor, request) =>
        this.resolveConfigTarget(actor, request),
      modelViews: (actor) => this.modelViews(actor),
      readPresentation: (actor, target) =>
        this.readWorkspaceConfiguration(actor, target),
    });
    this.plugins = deps.plugins
      ? createCodeUiPluginsHost({
          registry: deps.plugins,
          resolveInstanceId: async (actor) =>
            (await deps.localInstance.resolve(actor)).instanceId,
          workspace: async (actor, request) => {
            const target = await this.resolveConfigTarget(actor, {
              ...request,
            });
            const project = (await this.listWorkspaces(actor)).find(
              (entry) => entry.projectId === target.projectId,
            );
            if (!project)
              throw new CodeUiRepositoryError(
                "not_found",
                "插件目标Project已经不可见。",
              );
            return { ...project, path: target.workspacePath };
          },
        })
      : undefined;
    this.watchers = createCodeUiFileWatchers({
      assertConnection: (connection) => {
        const current = this.connections.require(
          connection.instanceId,
          connection.connectionId,
          false,
        );
        if (current.hello.auth.userId !== connection.instanceId)
          throw new CodeUiRepositoryError(
            "not_found",
            "文件监视连接不属于当前用户。",
          );
      },
      resolveTarget: (actor, viewer, path) =>
        this.resolveWatchTarget(actor, viewer, path),
      send: (connection, watcherId, data) =>
        this.connections.send(connection.instanceId, connection.connectionId, {
          event: "service",
          service: "file-watcher",
          name: "onDynamicChange",
          watcherId,
          data,
        }),
    });
    this.git = deps.processSandbox
      ? createCodeUiHostGitRpc({
          resolveTarget: (actor, request) =>
            this.resolveHostTarget(actor, request),
          openSession: async (actor, target) => {
            if (target.viewerScope.kind !== "task")
              throw new CodeUiRepositoryError(
                "not_found",
                "请先创建或选择Task再使用Git。",
              );
            const scope = (
              await deps.executionScopes.openTask(
                actor,
                target.viewerScope.taskId,
              )
            ).derive("review", `human-git:${randomUUID()}`);
            const settings = await deps.settings.getInstanceSettings(
              actor,
              target.instanceId,
            );
            return {
              rootDirectory: scope.describe().rootDirectory,
              available: deps.env.gitSource !== "unavailable",
              limits: settings,
              resolvePath: (path, operation) =>
                scope.resolvePath(path, operation),
              exec: createScopedGitExec({
                scope,
                sandbox: deps.processSandbox!,
                binary: deps.env.gitBinDir
                  ? join(
                      deps.env.gitBinDir,
                      process.platform === "win32" ? "git.exe" : "git",
                    )
                  : "git",
                timeoutMs: settings.executeTimeoutMs,
                limits: {
                  maxOutputBytes: settings.processMaxOutputBytes,
                  previewMaxChars: settings.processPreviewMaxChars,
                  yieldMs: settings.processYieldMs,
                  killGraceMs: settings.processKillGraceMs,
                },
              }),
            };
          },
        })
      : undefined;
    this.hostServices =
      deps.skillRepository && deps.skillSettingsRepository
        ? createCodeUiHostServicesRpc({
            skills: deps.skillRepository,
            skillSettings: deps.skillSettingsRepository,
            resolveTarget: (actor, request) =>
              this.resolveHostTarget(actor, request),
          })
        : undefined;
    this.attachments =
      deps.blob && deps.attachmentRepository
        ? createCodeAttachmentHost({
            repository: deps.repository,
            attachments: deps.attachmentRepository,
            blob: deps.blob,
            localInstance: deps.localInstance,
            settings: deps.settings,
          })
        : undefined;
    this.providerSettings = createCodeUiProviderSettingsRpc({
      modelProviders: deps.modelProviders,
      modelCatalog: deps.modelCatalog,
      settings: deps.settings,
      instanceId: async (actor) =>
        (await deps.localInstance.resolve(actor)).instanceId,
      preferences: deps.repository,
      notifyViews: async (actor, views) => {
        const owner = (await deps.localInstance.resolve(actor)).instanceId;
        await this.connections.notify(
          owner,
          "providerSettingsService",
          "onDidChange",
          "",
          views.settings,
        );
        await this.connections.notify(
          owner,
          "modelSelectionService",
          "onDidChange",
          "",
          views.selection,
        );
        await this.refreshWorkspaceConfiguration(owner);
      },
      testConnectivity: async (actor, target) => {
        const settings = await deps.settings.getInstanceSettings(
          actor,
          (await deps.localInstance.resolve(actor)).instanceId,
        );
        const result = await deps.modelProviders.testModelConnectivity(
          actor,
          { instanceId: target.providerId, modelId: target.modelId },
          {
            timeoutMs: settings.executeTimeoutMs,
            maxAttempts: settings.llmRequestMaxRetries,
            infinite: settings.llmInfiniteRetry,
          },
        );
        return result.success
          ? { success: true }
          : {
              success: false,
              error: {
                message: result.error?.message ?? "供应商模型连接失败。",
              },
            };
      },
    });
    this.humanWorkspace = createHumanWorkspaceRpc({
      projects: deps.projects,
      preferences: deps.repository,
      instanceId: async (actor) =>
        (await deps.localInstance.resolve(actor)).instanceId,
      listWorkspaces: (actor) => this.listWorkspaces(actor),
      maxEntries: async (actor) =>
        deps.settings
          .getInstanceSettings(
            actor,
            (await deps.localInstance.resolve(actor)).instanceId,
          )
          .then((settings) => settings.codeSearchMaxResults),
      resolveTaskPreference: async (actor, taskId) => {
        const workspace = await deps.localInstance.resolve(actor);
        const root = await deps.repository.find(workspace.instanceId, taskId);
        if (
          !root?.state ||
          root.id !== root.root_session_id ||
          root.parent_session_id ||
          root.archived ||
          root.deleted_at ||
          !root.root_directory
        )
          return null;
        if (
          !(await deps.projects.listProjects(actor, "code")).some(
            (project) => project.id === root.project_id,
          )
        )
          return null;
        return {
          projectId: root.project_id,
          rootDirectory: root.root_directory,
        };
      },
    });
  }

  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await this.deps.taskWork.initialize();
      await this.deps.repository.recoverRuntimeInputs(this.inputOwner);
    })();
    return this.initialization;
  }

  async admitExternalRun(
    actor: LocalActor,
    scopeHandle: ExecutionScopeHandle,
    runId: string,
    text: string,
  ): Promise<(event: StreamEvent) => Promise<void>> {
    const scope = scopeHandle.describe();
    const loaded = await this.loadConversation(actor, scope.taskId);
    const commandId = `agent-run:${runId}`;
    const envelope: protocol.CommandEnvelope = {
      clientId: "host.agent-runs",
      commandId,
      sessionId: scope.taskId,
      type: "sendText",
      payload: { text },
      issuedAt: Date.now(),
    };
    await this.deps.repository.applyCommand(
      scope.instanceId,
      envelope,
      codeUiCommandFingerprint(envelope),
      (root) => {
        if (
          root.active_run_id ||
          root.state?.inputs?.some((record) => record.status === "reserved") ||
          root.execution_state !== "ready" ||
          Number(root.scope_generation) !== scope.generation
        )
          throw new CodeUiRepositoryError(
            "command_conflict",
            "Task 已忙碌或工作域改变，未启动 Run",
          );
        const current = root.state!.snapshots.find(
          (entry) => entry.sessionId === root.id,
        )!;
        const host = createCodeUiConversation({
          sessionId: root.id,
          workspacePath: root.root_directory!,
          config: current.config,
          state: root.state!,
        });
        host.setInputOwner(this.inputOwner);
        host.startTurn({ runId, commandId, text });
        return {
          state: host.exportState(),
          activeRunId: runId,
          ack: {
            commandId,
            status: "accepted",
            revisionAtDecision: host.getSnapshot().revision,
            result: {
              type: "inputAccepted",
              delivery: "startNow",
              inputId: commandId,
            },
          },
        };
      },
    );
    this.taskActors.set(
      JSON.stringify([scope.instanceId, scope.taskId]),
      actor,
    );
    await this.refreshTaskProjection(
      scope.instanceId,
      loaded.project.path,
      loaded.project.projectId,
    );
    let ordinal = 0;
    return (event) =>
      this.recordRunEvent(
        actor,
        loaded.project,
        scope.taskId,
        event,
        ++ordinal,
      );
  }

  async onApprovalEvent(event: ApprovalEvent): Promise<void> {
    return this.onBoundInteractionEvent(event);
  }

  async onUserInputEvent(event: UserInputEvent): Promise<void> {
    return this.onBoundInteractionEvent(event);
  }

  private async onBoundInteractionEvent(
    event: ApprovalEvent | UserInputEvent,
  ): Promise<void> {
    const { instanceId, taskId } = event.identity;
    const root = await this.deps.repository.find(instanceId, taskId);
    if (!root?.state || root.deleted_at) {
      if (event.type !== "cancelled" && event.interaction.kind === "userInput")
        throw new CodeUiRepositoryError("not_found", "提问所属 Task 已不存在");
      return;
    }
    // 请求必须属于尚有效的授权；cancel回执仍需清掉旧代际UI阻塞。
    if (
      event.type === "requested" &&
      (root.archived ||
        root.execution_state !== "ready" ||
        Number(root.scope_generation) !== event.identity.scopeGeneration ||
        Number(root.branch_generation) !== event.identity.branchGeneration)
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "审批请求的 Task 代际已失效",
      );
    await this.deps.repository.appendEvent(
      instanceId,
      taskId,
      {
        key: `${event.interaction.kind === "permission" ? "approval" : "user-input"}:${event.interaction.interactionId}/${event.type}`,
        fingerprint: createHash("sha256")
          .update(canonical(event))
          .digest("hex"),
        event,
      },
      (current) => {
        if (
          event.interaction.kind === "userInput" &&
          event.type !== "cancelled"
        )
          requireLiveUserInput(current, event);
        const snapshot = current.state!.snapshots.find(
          (entry) => entry.sessionId === current.id,
        )!;
        const host = createCodeUiConversation({
          sessionId: current.id,
          workspacePath: current.root_directory!,
          config: snapshot.config,
          state: current.state!,
        });
        host.recordInteractionEvent(event);
        return {
          state: host.exportState(),
          activeRunId: current.active_run_id,
        };
      },
    );
    if (root.root_directory)
      await this.refreshTaskProjection(
        instanceId,
        root.root_directory,
        root.project_id,
      );
  }

  async openChildSession(request: CodeChildRequest): Promise<ChildSession> {
    const scope = request.scope.describe();
    const loaded = await this.loadConversation(
      request.actor,
      request.parentSessionId,
    );
    if (
      loaded.root.id !== scope.taskId ||
      loaded.instanceId !== scope.instanceId
    )
      throw new CodeUiRepositoryError("not_found", "子任务不属于父Task");
    const threadId = `code-child:${request.childSessionId}`;
    const fact = {
      parentSessionId: request.parentSessionId,
      parentRunId: request.parentRunId,
      toolCallId: request.toolCallId,
      childSessionId: request.childSessionId,
      role: request.role,
      title: request.description,
      detached: request.detached,
      at: Date.now(),
    };
    const fingerprint = createHash("sha256")
      .update(
        canonical({
          ...fact,
          at: undefined,
          scopeGeneration: scope.generation,
          branchGeneration: request.branchGeneration,
          ownership: request.ownership,
          criteria: request.completionCriteria,
          approvalCeiling: request.approvalCeiling,
        }),
      )
      .digest("hex");
    await this.deps.repository.appendEvent(
      scope.instanceId,
      scope.taskId,
      {
        key: `child-dispatch:${request.parentRunId}/${request.toolCallId}`,
        fingerprint,
        event: fact,
      },
      (root) => {
        if (
          root.archived ||
          root.execution_state !== "ready" ||
          Number(root.scope_generation) !== scope.generation ||
          Number(root.branch_generation) !== request.branchGeneration
        )
          throw new CodeUiRepositoryError(
            "command_conflict",
            "子派发的Task代际已失效",
          );
        const parent = root.state!.snapshots.find(
          (snapshot) => snapshot.sessionId === request.parentSessionId,
        );
        if (!parent || parent.control.phase !== "running")
          throw new CodeUiRepositoryError(
            "command_conflict",
            "父会话已经结束，不能接受新的子派发",
          );
        const snapshot = root.state!.snapshots.find(
          (entry) => entry.sessionId === root.id,
        )!;
        const host = createCodeUiConversation({
          sessionId: root.id,
          workspacePath: root.root_directory!,
          config: snapshot.config,
          state: root.state!,
        });
        host.registerChildDispatch(fact);
        return {
          state: host.exportState(),
          activeRunId: root.active_run_id,
          childChat: {
            sessionId: request.childSessionId,
            threadId,
            createdByClientId: request.actor.accessClientId,
            title: request.description,
          },
        };
      },
    );
    await this.refreshTaskProjection(
      scope.instanceId,
      loaded.root.root_directory!,
      loaded.root.project_id,
    );
    let ordinal = 0;
    return {
      sessionId: request.childSessionId,
      threadId,
      emit: async (event) => {
        await this.deps.repository.appendEvent(
          scope.instanceId,
          scope.taskId,
          {
            key: `child-event:${request.childSessionId}/${event.runId}/${++ordinal}`,
            fingerprint: createHash("sha256")
              .update(canonical(event))
              .digest("hex"),
            event,
          },
          (root) => {
            if (Number(root.branch_generation) !== request.branchGeneration)
              return { state: root.state!, activeRunId: root.active_run_id };
            const snapshot = root.state!.snapshots.find(
              (entry) => entry.sessionId === root.id,
            )!;
            const host = createCodeUiConversation({
              sessionId: root.id,
              workspacePath: root.root_directory!,
              config: snapshot.config,
              state: root.state!,
            });
            host.recordChildRunEvent(request.childSessionId, event);
            return {
              state: host.exportState(),
              activeRunId: root.active_run_id,
            };
          },
        );
        await this.refreshTaskProjection(
          scope.instanceId,
          loaded.root.root_directory!,
          loaded.root.project_id,
        );
      },
      storeResult: async (text) => {
        const settings = await this.deps.settings.getInstanceSettings(
          request.actor,
          scope.instanceId,
        );
        const directory = join(
          dirname(resolve(this.deps.env.checkpointRoot ?? "data/checkpoints")),
          "execution-output",
          scope.instanceId,
          scope.taskId,
          "children",
        );
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${request.childSessionId}.log`);
        const temporary = `${path}.${randomUUID()}.tmp`;
        const bytes = Buffer.from(text);
        let length = Math.min(bytes.length, settings.processMaxOutputBytes);
        // UTF8 continuation位是编码常量；截断容量来自治理设置。
        while (
          length < bytes.length &&
          length > 0 &&
          (bytes[length]! & 0xc0) === 0x80
        )
          length -= 1;
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(bytes.subarray(0, length));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        return {
          path,
          stats: {
            retainedBytes: length,
            totalBytes: bytes.length,
            discardedBytes: bytes.length - length,
          },
        };
      },
    };
  }

  async rewindTask(
    actor: LocalActor,
    taskId: string,
    expectedScopeGeneration: number,
    guard?: Pick<
      protocol.V4ConversationFileChangesParams,
      "baseRevision" | "baseLogEpoch"
    >,
  ): Promise<ExecutionScopeHandle> {
    const loaded = await this.loadConversation(actor, taskId);
    if (loaded.entry.parent_session_id)
      throw new CodeUiRepositoryError(
        "not_found",
        "文件恢复只接受根 Task 身份",
      );
    if (!this.deps.beforeCloseTask)
      throw new ExecutionScopeError(
        "closer_unavailable",
        "执行资源关闭器不可用，不能安全恢复文件。",
        503,
      );
    const generation = await this.deps.repository.beginRewindTask(
      loaded.instanceId,
      taskId,
      expectedScopeGeneration,
      guard,
    );
    try {
      await this.deps.beforeCloseTask(actor, taskId, "branch");
      await this.attachments?.releaseTask(loaded.instanceId, taskId);
      const current = await this.deps.repository.find(
        loaded.instanceId,
        taskId,
      );
      if (!current?.state)
        throw new CodeUiRepositoryError(
          "not_found",
          "Task 在恢复准备期间被删除",
        );
      const snapshot = current.state.snapshots.find(
        (entry) => entry.sessionId === current.id,
      )!;
      const host = createCodeUiConversation({
        sessionId: current.id,
        workspacePath: current.root_directory!,
        config: snapshot.config,
        state: current.state,
      });
      if (current.active_run_id)
        host.recordEvent({
          type: "run.canceled",
          runId: current.active_run_id,
          timestamp: new Date().toISOString(),
        });
      const state = host.exportState();
      // 分支已推进且旧资源确已退出，旧分支的后台卡片不能跟入新分支。
      for (const entry of state.snapshots) entry.backgroundWorks = [];
      // 只更新转录，保持 revoking；整个恢复 batch 与后快照完成后才开放普通 Run。
      await this.deps.repository.save(
        loaded.instanceId,
        taskId,
        Number(current.revision),
        state,
        null,
      );
      return await this.deps.executionScopes.openRestoringTask(
        actor,
        taskId,
        generation,
      );
    } catch (error) {
      await this.deps.repository.failCloseTask(
        loaded.instanceId,
        taskId,
        generation,
      );
      throw error;
    }
  }

  async finishTaskRestore(
    scope: ExecutionScopeHandle,
    actor: LocalActor,
    success: boolean,
  ): Promise<void> {
    const identity = scope.describe();
    const workspace = await this.deps.localInstance.resolve(actor);
    if (workspace.instanceId !== identity.instanceId)
      throw new CodeUiRepositoryError(
        "not_found",
        "恢复作用域不属于当前工作区",
      );
    if (!success) {
      await this.deps.repository.failCloseTask(
        workspace.instanceId,
        identity.taskId,
        identity.generation,
      );
      return;
    }
    const root = await this.deps.repository.find(
      workspace.instanceId,
      identity.taskId,
    );
    if (!root?.state)
      throw new CodeUiRepositoryError("not_found", "恢复 Task 已删除");
    await this.deps.repository.finishRewindTask(
      workspace.instanceId,
      root.id,
      identity.generation,
      root.state,
      root.active_run_id,
    );
    // ready 的真实提交已完成，通知失败不改写完成状态或触发重复恢复。
    const notifications = await Promise.allSettled([
      this.refreshTaskProjection(
        workspace.instanceId,
        root.root_directory!,
        root.project_id,
      ),
      this.deps.taskWork.notifyReady(workspace.instanceId, root.id),
    ]);
    for (const result of notifications)
      if (result.status === "rejected")
        console.warn("[code-ui] 文件恢复已完成，后续通知失败：", result.reason);
  }

  /** 后台记录先持久化，原 V4 聚合再投影；旧 Run 终态不屏蔽 Task 级更新。 */
  async onTaskWorkChanged(record: TaskWorkRecord) {
    const root = await this.deps.repository.find(
      record.scope.instanceId,
      record.scope.taskId,
    );
    if (
      !root?.state ||
      root.deleted_at ||
      root.archived ||
      Number(root.branch_generation) !== record.branchGeneration
    )
      return;
    const event: Extract<StreamEvent, { type: "task.work" }> = {
      type: "task.work",
      runId: record.originRunId,
      timestamp: record.endedAt ?? record.startedAt,
      work: {
        workId: record.id,
        taskId: record.scope.taskId,
        branchGeneration: record.branchGeneration,
        originRunId: record.originRunId,
        toolCallId: record.toolCallId,
        kind: record.kind,
        label: record.label,
        status: record.status,
        startedAt: record.startedAt,
        consumed: record.consumed,
        detached: record.detached,
        ...(record.endedAt ? { endedAt: record.endedAt } : {}),
        ...(record.summary !== undefined ? { summary: record.summary } : {}),
        ...(record.childSessionId
          ? { childSessionId: record.childSessionId }
          : {}),
      },
    };
    const applied = await this.deps.repository.appendEvent(
      record.scope.instanceId,
      root.id,
      {
        key: `task-work/${record.id}/${record.status}/${record.consumed}`,
        fingerprint: createHash("sha256")
          .update(canonical(event))
          .digest("hex"),
        event,
      },
      (current) => {
        if (Number(current.branch_generation) !== record.branchGeneration)
          throw new CodeUiRepositoryError(
            "command_conflict",
            "后台工作所属分支已改变",
          );
        const snapshot = current.state!.snapshots.find(
          (entry) => entry.sessionId === current.id,
        )!;
        const host = createCodeUiConversation({
          sessionId: current.id,
          workspacePath: current.root_directory!,
          config: snapshot.config,
          state: current.state!,
        });
        host.recordEvent(event);
        return {
          state: host.exportState(),
          activeRunId: current.active_run_id,
        };
      },
    );
    if (applied && root.root_directory)
      await this.refreshTaskProjection(
        record.scope.instanceId,
        root.root_directory,
        root.project_id,
      );
  }

  /** 空闲续跑由真正的终态触发；命令认领和前台 lease 共同拒绝重复/并发新 Run。 */
  async resumeTaskWork(instanceId: string, taskId: string): Promise<boolean> {
    if (this.closing) return false;
    const actor = this.taskActors.get(JSON.stringify([instanceId, taskId]));
    if (!actor) return false;
    const loaded = await this.loadConversation(actor, taskId);
    if (
      loaded.root.active_run_id ||
      loaded.root.state?.inputs?.some(
        (record) => record.status === "reserved",
      ) ||
      loaded.host.getSnapshot().control.phase === "running"
    )
      return false;
    const scopeHandle = await this.deps.executionScopes.openTask(actor, taskId);
    const context: TaskWorkContext = {
      actor,
      scope: scopeHandle.describe(),
      agentId: scopeHandle.agentId,
      runId: "continuation-admission",
      branchGeneration: Number(loaded.root.branch_generation),
    };
    const pending = (await this.deps.taskWork.list(context)).filter(
      (record) =>
        record.branchGeneration === context.branchGeneration &&
        record.status !== "running" &&
        !record.consumed,
    );
    if (pending.length === 0) return false;
    const snapshot = loaded.host.getSnapshot();
    const selection = (
      await this.modelViews(actor, snapshot.config.modelSelection)
    ).selection.effectiveSelection;
    if (!selection)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "后台结果已就绪，但当前模型不可执行，请检查供应商配置",
      );
    const modelInvocation = await this.prepareModelInvocation(actor, selection);
    const thread = await this.deps.threads.resolveOwnedSessionThread(
      actor,
      taskId,
    );
    const commandId = `task-work:${createHash("sha256")
      .update(
        `${context.branchGeneration}/${pending
          .map((record) => record.id)
          .sort()
          .join(",")}`,
      )
      .digest("hex")}`;
    const runId = randomUUID();
    const text =
      "后台工作已有终态结果。请读取本轮模型边界送达的工作记录，继续完成当前 Task。";
    const envelope: protocol.CommandEnvelope = {
      clientId: "host.task-work",
      commandId,
      sessionId: taskId,
      type: "sendText",
      payload: { text },
      issuedAt: Date.now(),
    };
    const ack = await this.deps.repository.applyCommand(
      instanceId,
      envelope,
      codeUiCommandFingerprint(envelope),
      (root) => {
        if (
          root.active_run_id ||
          root.state?.inputs?.some((record) => record.status === "reserved") ||
          Number(root.branch_generation) !== context.branchGeneration
        )
          throw new CodeUiRepositoryError(
            "command_conflict",
            "Task 已忙碌或分支改变，后台结果留待下一模型边界",
          );
        const current = root.state!.snapshots.find(
          (entry) => entry.sessionId === root.id,
        )!;
        const host = createCodeUiConversation({
          sessionId: root.id,
          workspacePath: root.root_directory!,
          config: current.config,
          state: root.state!,
        });
        host.startTurn({ runId, commandId, text, origin: "backgroundResult" });
        return {
          state: host.exportState(),
          activeRunId: runId,
          ack: {
            commandId,
            status: "accepted",
            revisionAtDecision: host.getSnapshot().revision,
            result: {
              type: "inputAccepted",
              delivery: "startNow",
              inputId: commandId,
            },
          },
        };
      },
    );
    if (ack.status === "duplicate") return true;
    await this.refreshTaskProjection(
      instanceId,
      loaded.project.path,
      loaded.project.projectId,
    );
    // 调度只等持久 admission；runTurn 独立消费事件，不让终态 executor 等模型完整运行。
    void this.runTurn(
      actor,
      loaded.project,
      taskId,
      thread.threadId,
      runId,
      text,
      `${selection.providerId}:${selection.modelId}`,
      modelInvocation,
      undefined,
      { clientId: envelope.clientId, sourceCommandId: envelope.commandId },
    ).catch((error: unknown) =>
      console.error("[task-work] 自动续跑失败：", error),
    );
    return true;
  }

  async openConnection(
    user: LocalActor,
    send: (event: CodeUiEvent) => Promise<void>,
    close: () => void,
  ) {
    await this.initialize();
    const workspace = await this.deps.localInstance.resolve(user);
    const settings = await this.deps.settings.getInstanceSettings(
      user,
      workspace.instanceId,
    );
    const connection = this.connections.open(
      workspace.instanceId,
      user.instanceId,
      send,
      close,
      Boolean(this.deps.terminals),
      true,
      user.accessClientId,
    );
    return {
      ...connection,
      reconnectDelayMs: settings.codeUiReconnectDelayMs,
      dispose: async () => {
        connection.dispose();
        await this.closeResources([
          this.controllers
            .get(connection.hello.connectionId)
            ?.host.dispose()
            .then(() => {
              this.controllers.delete(connection.hello.connectionId);
            }),
          this.deps.terminals?.closeConnection(
            workspace.instanceId,
            connection.hello.connectionId,
            "Code通知连接关闭",
          ),
          this.attachmentsUsed
            ? this.attachments?.releaseConnection(
                workspace.instanceId,
                connection.hello.connectionId,
              )
            : undefined,
          this.watchers.closeConnection(
            workspace.instanceId,
            connection.hello.connectionId,
          ),
        ]);
      },
    };
  }

  async closeConnections() {
    this.closing = true;
    try {
      await this.closeResources(
        [...this.controllers.values()]
          .map((controller) => controller.host.dispose())
          .concat(
            [
              this.deps.terminals?.close("Code通知宿主关闭"),
              this.attachments?.close(),
              this.watchers.close(),
            ].filter(
              (resource): resource is Promise<void> => resource !== undefined,
            ),
          ),
      );
      this.controllers.clear();
    } finally {
      this.connections.closeAll();
    }
  }

  private async closeResources(
    resources: Array<Promise<void> | undefined>,
  ): Promise<void> {
    const failures = (
      await Promise.allSettled(
        resources.filter(
          (resource): resource is Promise<void> => resource !== undefined,
        ),
      )
    ).flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Code连接资源尚未全部确认关闭。");
  }

  closeTaskWatchers(instanceId: string, taskId: string): Promise<void> {
    return this.watchers.closeTask(instanceId, taskId);
  }

  private async refreshTaskProjection(
    instanceId: string,
    path: string,
    projectId: string,
  ) {
    try {
      await this.connections.refresh(instanceId, path, projectId);
    } catch (error) {
      console.warn("[code-ui] 事实已持久化，订阅刷新失败：", error);
    }
  }

  private async refreshTaskLists(
    instanceId: string,
    path: string,
    projectId: string,
  ) {
    try {
      await Promise.all(
        [...this.controllers.values()]
          .filter((controller) => controller.instanceId === instanceId)
          .map((controller) => controller.host.refresh()),
      );
      await this.refreshTaskProjection(instanceId, path, projectId);
    } catch (error) {
      console.warn("[code-ui] Task列表事实已持久化，订阅刷新失败：", error);
    }
  }

  private async closeTaskResources(
    user: LocalActor,
    taskId: string,
    reason: "archive" | "delete",
  ) {
    const workspace = await this.deps.localInstance.resolve(user);
    const root = await this.deps.repository.find(workspace.instanceId, taskId);
    if (!root || root.parent_session_id)
      throw new CodeUiRepositoryError("not_found", "根 Task 不存在或已经删除");
    if (!this.deps.beforeCloseTask)
      throw new ExecutionScopeError(
        "closer_unavailable",
        "Task 执行资源关闭器不可用，不能报告已关闭。",
        503,
      );
    const generation = await this.deps.repository.beginCloseTask(
      workspace.instanceId,
      root.id,
    );
    try {
      await this.deps.beforeCloseTask(user, root.id, reason);
      await this.attachments?.releaseTask(workspace.instanceId, root.id);
      if (reason === "delete")
        await this.attachments?.purgeTask(user, root.id, generation);
      forgetTaskFileState(workspace.instanceId, root.id);
      return { instanceId: workspace.instanceId, root };
    } catch (error) {
      await this.deps.repository.failCloseTask(
        workspace.instanceId,
        root.id,
        generation,
      );
      throw new ExecutionScopeError(
        "close_failed",
        error instanceof Error ? error.message : "执行资源尚未确认退出。",
        503,
      );
    }
  }

  async archiveTask(user: LocalActor, taskId: string): Promise<void> {
    const { instanceId, root } = await this.closeTaskResources(
      user,
      taskId,
      "archive",
    );
    await this.deps.repository.setListState(instanceId, root.id, {
      archived: true,
    });
    await this.deps.repository.failCloseTask(instanceId, root.id);
    this.taskActors.delete(JSON.stringify([instanceId, root.id]));
    await this.refreshTaskLists(
      instanceId,
      root.root_directory!,
      root.project_id,
    );
  }

  async deleteTask(user: LocalActor, taskId: string): Promise<void> {
    const { instanceId, root } = await this.closeTaskResources(
      user,
      taskId,
      "delete",
    );
    await this.deps.repository.delete(instanceId, root.id);
    this.taskActors.delete(JSON.stringify([instanceId, root.id]));
    await this.refreshTaskLists(
      instanceId,
      root.root_directory!,
      root.project_id,
    );
  }

  async hostRpc(
    user: LocalActor,
    service: string,
    method: string,
    args: unknown[],
    connectionId?: string,
  ) {
    if (connectionId !== undefined) {
      const owner = await this.deps.localInstance.resolve(user);
      this.connections.require(
        owner.instanceId,
        connectionId,
        false,
        user.accessClientId,
      );
    }
    if (service === "window-controller") {
      const owner = await this.deps.localInstance.resolve(user);
      const connection = this.connections.require(
        owner.instanceId,
        connectionId,
        true,
        user.accessClientId,
      );
      if (this.closing)
        throw new CodeUiRepositoryError("not_found", "Code通知宿主已关闭。");
      let controller = this.controllers.get(
        connection.hello.connectionId,
      )?.host;
      if (!controller) {
        controller = createCodeUiWindowController({
          actor: user,
          instanceId: owner.instanceId,
          connectionId: connection.hello.connectionId,
          connections: this.connections,
          repository: this.deps.repository,
          settings: this.deps.settings,
          listWorkspaces: () => this.listWorkspaces(user),
        });
        this.controllers.set(connection.hello.connectionId, {
          instanceId: owner.instanceId,
          host: controller,
        });
      }
      if (method === "listTaskList") {
        const query = codeUiControllerTaskListQuerySchema.parse(args[0]);
        const settings = await this.deps.settings.getInstanceSettings(
          user,
          owner.instanceId,
        );
        return controller.call(method, {
          ...query,
          limit: Math.min(
            query.limit ?? settings.codeSearchMaxResults,
            settings.codeSearchMaxResults,
          ),
        });
      }
      return controller.call(method, args[0]);
    }
    if (service === "plugin-management" && this.plugins) {
      const owner = await this.deps.localInstance.resolve(user);
      this.connections.require(
        owner.instanceId,
        connectionId,
        false,
        user.accessClientId,
      );
      return this.plugins.call(user, method, args[0]);
    }
    if (service === "file-watcher" || service === "git") {
      const owner = await this.deps.localInstance.resolve(user);
      const current = this.connections.require(
        owner.instanceId,
        connectionId,
        false,
      );
      if (current.hello.auth.userId !== user.instanceId)
        throw new CodeUiRepositoryError(
          "not_found",
          "宿主连接不属于当前用户。",
        );
      const connection = {
        connectionId: connectionId!,
        instanceId: owner.instanceId,
      };
      return service === "file-watcher"
        ? this.watchers.call(user, method, args, connection)
        : (this.git?.call(user, method, args, connection) ?? null);
    }
    if (service === "skills" && this.hostServices) {
      const owner = await this.deps.localInstance.resolve(user);
      this.connections.require(owner.instanceId, connectionId, false);
      return this.hostServices.call(user, service, method, args, {
        connectionId: connectionId!,
        instanceId: owner.instanceId,
      });
    }
    if (
      service === "providerSettingsService" ||
      service === "modelSelectionService"
    ) {
      const owner = await this.deps.localInstance.resolve(user);
      this.connections.require(owner.instanceId, connectionId, false);
      return this.providerSettings.call(user, service, method, args);
    }
    if (service === "terminal" && this.deps.terminals) {
      const owner = await this.deps.localInstance.resolve(user);
      this.connections.require(owner.instanceId, connectionId, false);
      const preferences = appSettingsSchema.parse(
        await this.deps.repository.readHumanPreferences(owner.instanceId),
      );
      return codeUiTerminalRpc({
        terminals: this.deps.terminals,
        actor: user,
        connectionId: connectionId!,
        method,
        args,
        preferences: {
          terminalInheritSystemProfile:
            preferences.terminalInheritSystemProfile,
          ...(preferences.terminalFontFamily !== undefined
            ? { terminalFontFamily: preferences.terminalFontFamily }
            : {}),
        },
        subscriber: (terminalId) => ({
          output: (data) =>
            this.connections.send(owner.instanceId, connectionId!, {
              event: "service",
              service: "terminal",
              name: "onDynamicData",
              terminalId,
              data,
            }),
          exit: (exit) =>
            this.connections.send(owner.instanceId, connectionId!, {
              event: "service",
              service: "terminal",
              name: "onDynamicExit",
              terminalId,
              data: exit.exitCode ?? -1,
            }),
        }),
      });
    }
    if (
      service === "workspace" ||
      service === "file" ||
      service === "setting"
    ) {
      const owner = await this.deps.localInstance.resolve(user);
      const connection = this.connections.require(
        owner.instanceId,
        connectionId,
        false,
      );
      const human = await this.humanWorkspace.call(user, service, method, args);
      if (human) return human;
      if (service === "file") {
        const settings = await this.deps.settings.getInstanceSettings(
          user,
          owner.instanceId,
        );
        let fileIndex = this.fileIndexes.get(connection);
        if (!fileIndex) {
          fileIndex = new CodeUiFileIndex();
          this.fileIndexes.set(connection, fileIndex);
        }
        const opened = new Map<string, ExecutionScopeHandle>();
        return codeUiViewerRpc({
          method,
          value: args[0],
          limits: settings,
          fileIndex,
          resolvePath: async (viewer, path) => {
            if (viewer.kind === "task") {
              let scope = opened.get(viewer.taskId);
              if (!scope) {
                scope = await this.deps.executionScopes.openTask(
                  user,
                  viewer.taskId,
                );
                opened.set(viewer.taskId, scope);
              }
              return scope.resolvePath(path, "read");
            }
            const project = (await this.listWorkspaces(user)).find(
              (entry) => entry.projectId === viewer.projectId,
            );
            if (!project)
              throw new CodeUiRepositoryError(
                "not_found",
                "文件预览的 Code 项目不可见。",
              );
            return resolveReadOnlyProjectPath(
              {
                rootDirectory: project.path,
                additionalDirectories: project.additionalDirectories,
              },
              path,
            );
          },
        });
      }
    }
    if (service === "zcode-task") return this.taskIndexRpc(user, method, args);
    if (service === "system" && method === "info")
      return { result: { homedir: homedir(), platform: process.platform } };
    if (service === "zcode-session" && method === "readWorkspacePresentation") {
      const request = args[0] as CodeUiWorkspaceConfigRequest;
      const target = await this.resolveConfigTarget(user, request);
      const presentation = await this.readWorkspaceConfiguration(user, target);
      return {
        result: zcodeWorkspacePresentationSchema.parse({
          workspace: {
            workspacePath: target.workspacePath,
            workspaceKey: request.workspaceIdentity ?? target.workspacePath,
          },
          ...presentation,
        }),
      };
    }
    return null;
  }

  private async taskIndexRpc(
    user: LocalActor,
    method: string,
    args: unknown[],
  ) {
    const supported = new Set([
      "listTasks",
      "listPinnedTasks",
      "listArchivedTasks",
      "listPinnedTaskIds",
      "listDeletedTaskIds",
      "getTaskMeta",
    ]);
    if (!supported.has(method)) return null;
    const workspace = await this.deps.localInstance.resolve(user);
    const projects = await this.listWorkspaces(user);
    const target = args[0] as {
      workspacePath: string;
      taskId?: string;
      projectId?: string;
    };
    if (method === "getTaskMeta") {
      const found = target?.taskId
        ? await this.deps.repository.find(workspace.instanceId, target.taskId)
        : null;
      const record =
        found &&
        !found.deleted_at &&
        !found.parent_session_id &&
        found.id === found.root_session_id
          ? found
          : null;
      const project =
        record &&
        projects.find((entry) => entry.projectId === record.project_id);
      if (target?.projectId && project?.projectId !== target.projectId)
        throw new CodeUiRepositoryError(
          "not_found",
          "Task 不属于指定 Code 项目。",
        );
      return {
        result:
          record?.root_directory && project
            ? codeUiTaskMeta(record, record.root_directory)
            : null,
      };
    }
    const records = await this.deps.repository.listRoots(workspace.instanceId);
    if (method === "listPinnedTaskIds")
      return {
        result: records
          .filter(
            (entry) =>
              entry.pinned &&
              !entry.archived &&
              entry.root_directory &&
              projects.some(
                (project) => project.projectId === entry.project_id,
              ) &&
              codeUiTaskMeta(entry, entry.root_directory),
          )
          .map((entry) => entry.id),
      };
    const project = await this.requireWorkspace(
      user,
      target.projectId ?? target.workspacePath,
    );
    const scoped = records.filter(
      (entry) => entry.project_id === project.projectId,
    );
    if (method === "listDeletedTaskIds")
      return {
        result: scoped
          .filter((entry) => entry.deleted_at)
          .map((entry) => entry.id),
      };
    const visible = scoped.filter((entry) =>
      method === "listArchivedTasks"
        ? entry.archived
        : method === "listPinnedTasks"
          ? entry.pinned && !entry.archived
          : !entry.archived && !entry.pinned,
    );
    return {
      result: visible.flatMap((entry) => {
        const meta = entry.root_directory
          ? codeUiTaskMeta(entry, entry.root_directory)
          : null;
        return meta ? [meta] : [];
      }),
    };
  }

  async transportRpc(
    user: LocalActor,
    connectionId: string | undefined,
    method: string,
    args: unknown[],
  ): Promise<{ result: unknown; publish?: () => Promise<void> } | null> {
    const workspace = await this.deps.localInstance.resolve(user);
    if (connectionId !== undefined)
      this.connections.require(
        workspace.instanceId,
        connectionId,
        false,
        user.accessClientId,
      );
    if (method === "helloConversationV4")
      return {
        result: this.connections.require(
          workspace.instanceId,
          connectionId,
          false,
        ).hello,
      };
    if (method === "initializeConversationV4") {
      this.connections.initialize(workspace.instanceId, connectionId, args[0]);
      return { result: null };
    }
    if (
      method === "subscribeWorkspaceConfigV4" ||
      method === "resyncWorkspaceConfigV4" ||
      method === "unsubscribeWorkspaceConfigV4"
    ) {
      const connection = this.connections.require(
        workspace.instanceId,
        connectionId,
        true,
        user.accessClientId,
      );
      return this.workspaceConfig.call(user, method, args, {
        instanceId: workspace.instanceId,
        connectionId: connection.hello.connectionId,
      });
    }
    if (this.attachments && isCodeAttachmentRpc(method)) {
      this.connections.require(workspace.instanceId, connectionId, false);
      this.attachmentsUsed = true;
      const prepared = await codeAttachmentsRpc(
        this.attachments,
        user,
        method,
        args,
        connectionId ?? "",
      );
      return prepared;
    }
    const target = args[0] as {
      workspacePath: string;
      sessionId?: string;
      subscriptionId?: string;
      projectId?: string;
      workspaceIdentity?: string;
    };
    if (method === "subscribeConversationV4") {
      const params = protocol.subscribeParamsSchema.parse({
        topic: target.sessionId
          ? protocol.conversationTopic(target.sessionId)
          : undefined,
      });
      const sessionId = protocol.parseConversationTopic(params.topic);
      if (!sessionId)
        throw new CodeUiRepositoryError("not_found", "Code 会话 topic 无效");
      const project = (await this.loadConversation(user, sessionId)).project;
      if (target.projectId && target.projectId !== project.projectId)
        throw new CodeUiRepositoryError(
          "not_found",
          "会话不属于指定 Code 项目。",
        );
      const read = async () => {
        const loaded = await this.loadConversation(user, sessionId);
        if (loaded.project.projectId !== project.projectId)
          throw new CodeUiRepositoryError(
            "not_found",
            "会话不属于该 Code 工作目录",
          );
        const snapshot = loaded.host.getSnapshot(sessionId);
        await this.historyEdit.decorate(user, loaded, snapshot);
        return { snapshot, seq: snapshot.seq };
      };
      return this.connections.subscribe(workspace.instanceId, connectionId, {
        topic: params.topic,
        workspacePath: project.path,
        projectId: project.projectId,
        read,
      });
    }
    if (method === "subscribeSessionsIndexV4") {
      const project = await this.requireWorkspace(
        user,
        target.projectId ?? target.workspacePath,
      );
      const subscriptionPath = target.workspacePath;
      const qualifiedIdentity = JSON.stringify([
        project.projectId,
        subscriptionPath,
      ]);
      if (
        target.workspaceIdentity &&
        target.workspaceIdentity !== qualifiedIdentity
      )
        throw new CodeUiRepositoryError(
          "not_found",
          "会话索引身份与Project固定目录不匹配。",
        );
      if (
        target.workspaceIdentity &&
        project.path !== subscriptionPath &&
        !(await this.deps.repository.listRoots(workspace.instanceId)).some(
          (entry) =>
            entry.project_id === project.projectId &&
            entry.root_directory === subscriptionPath &&
            !entry.deleted_at &&
            !entry.parent_session_id,
        )
      )
        throw new CodeUiRepositoryError(
          "not_found",
          "会话索引目录没有当前Project或Task来源。",
        );
      const read = async () => ({
        snapshot: await this.sessionsIndex(
          user,
          subscriptionPath,
          project.projectId,
          target.workspaceIdentity,
        ),
        seq: await this.deps.repository.listVersion(
          workspace.instanceId,
          project.projectId,
        ),
      });
      return this.connections.subscribe(workspace.instanceId, connectionId, {
        topic: protocol.sessionsIndexTopic(
          target.workspaceIdentity ?? subscriptionPath,
        ),
        workspacePath: subscriptionPath,
        projectId: project.projectId,
        read,
      });
    }
    if (
      method === "resyncConversationV4" ||
      method === "resyncSessionsIndexV4"
    ) {
      const value = target as unknown as protocol.ConversationResyncParams;
      const params = protocol.conversationResyncParamsSchema.parse({
        subscriptionId: value.subscriptionId,
        base: value.base,
        ...(value.forceSnapshot !== undefined
          ? { forceSnapshot: value.forceSnapshot }
          : {}),
      });
      return this.connections.resync(
        workspace.instanceId,
        connectionId,
        params,
      );
    }
    if (
      method === "unsubscribeConversationV4" ||
      method === "unsubscribeSessionsIndexV4"
    ) {
      if (!target.subscriptionId)
        throw new CodeUiRepositoryError("not_found", "Code 订阅身份缺失");
      this.connections.unsubscribe(
        workspace.instanceId,
        connectionId,
        target.subscriptionId,
      );
      return { result: null };
    }
    if (method === "queryConversationCommandsV4") {
      const params = args[0] as protocol.CommandsQueryParams;
      const parsed = protocol.commandsQueryParamsSchema.parse({
        commands: params.commands,
        ...(params.clock ? { clock: true } : {}),
      });
      const clientId = this.connections.require(
        workspace.instanceId,
        connectionId,
      ).client!.clientId;
      return {
        result: await this.deps.repository.queryCommands(
          workspace.instanceId,
          clientId,
          parsed.commands,
        ),
      };
    }
    if (method === "conversationRowsRangeV4") {
      const parsed = protocol.v4ConversationRowsRangeParamsSchema.parse(
        args[0],
      );
      const snapshot = await this.getSnapshot(user, parsed.sessionId);
      const rows = snapshot.rows.window.filter(
        (row) =>
          parsed.beforeRowId === undefined || row.rowId < parsed.beforeRowId,
      );
      return {
        result: protocol.v4ConversationRowsRangeResultSchema.parse({
          rows: rows.slice(-parsed.limit),
          atSeq: snapshot.seq,
          atRevision: snapshot.revision,
          atLogEpoch: snapshot.logEpoch,
          hasMore: rows.length > parsed.limit,
        }),
      };
    }
    if (method === "conversationFileRewindPreviewV4")
      return this.fileHistory.preview(
        user,
        args[0] as Parameters<typeof this.fileHistory.preview>[1],
      );
    if (method === "conversationFileChangesV4") {
      const value = args[0] as protocol.V4ConversationFileChangesParams;
      const parsed = protocol.v4ConversationFileChangesParamsSchema.parse({
        sessionId: value.sessionId,
        target: value.target,
        baseRevision: value.baseRevision,
        baseLogEpoch: value.baseLogEpoch,
      });
      const loaded = await this.loadConversation(user, parsed.sessionId);
      const identity = JSON.stringify([
        loaded.project.projectId,
        loaded.project.path,
      ]);
      if (
        target.workspacePath !== loaded.project.path ||
        (target.projectId && target.projectId !== loaded.project.projectId) ||
        (target.workspaceIdentity && target.workspaceIdentity !== identity)
      )
        throw new CodeUiRepositoryError(
          "not_found",
          "文件变更不属于该Project与Task固定目录。",
        );
      const snapshot = loaded.host.getSnapshot(parsed.sessionId);
      const header = requireFileChangesTarget(snapshot, parsed);
      const limits = await this.deps.settings.getInstanceSettings(
        user,
        loaded.instanceId,
      );
      const events = await this.deps.repository.readToolCompletions(
        loaded.instanceId,
        loaded.root.id,
        header.turnId,
        {
          maxEvents: limits.codeSearchMaxResults,
          maxBytes: limits.codePatchMaxBytes,
        },
      );
      return {
        result: protocol.v4ConversationFileChangesResultSchema.parse(
          collectTurnFileChanges(snapshot, header.turnId, events),
        ),
      };
    }
    if (method === "sendConversationCommandV4") {
      const input = args[0] as { envelope?: unknown; workspacePath: string };
      const parsed = protocol.parseCommandEnvelope(input.envelope);
      if (!parsed.ok) throw parsed.error;
      if (connectionId) {
        const bound = this.connections.require(
          workspace.instanceId,
          connectionId,
        );
        if (bound.client!.clientId !== parsed.envelope.clientId)
          throw new CodeUiRepositoryError(
            "command_conflict",
            "Code 命令不属于握手客户端",
          );
      }
      if (parsed.envelope.type === "createSession")
        return { result: await this.createSession(user, parsed.envelope) };
      if (
        parsed.envelope.type === "sendText" ||
        parsed.envelope.type === "compact"
      )
        return this.sendText(user, input.workspacePath, parsed.envelope);
      if (
        parsed.envelope.type === "editUserQuery" ||
        parsed.envelope.type === "retryTurn"
      )
        return this.historyEdit.command(user, target, parsed.envelope);
      if (parsed.envelope.type === "applyFileRewind")
        return this.fileHistory.command(user, target, parsed.envelope);
      if (CODE_QUEUE_COMMANDS.has(parsed.envelope.type))
        return this.queueCommand(user, input.workspacePath, parsed.envelope);
      if (parsed.envelope.type === "switchCollaborationMode")
        return this.switchMode(user, input.workspacePath, parsed.envelope);
      if (parsed.envelope.type === "setFollowupMode")
        return this.setFollowupMode(user, input.workspacePath, parsed.envelope);
      if (parsed.envelope.type === "resolveInteraction")
        return this.resolveInteraction(
          user,
          input.workspacePath,
          parsed.envelope,
        );
      if (parsed.envelope.type === "stop")
        return this.stopExecution(user, parsed.envelope);
      if (parsed.envelope.type === "cancelBackgroundWork")
        return this.cancelBackgroundWork(user, parsed.envelope);
    }
    return null;
  }

  private async setFollowupMode(
    user: LocalActor,
    workspacePath: string,
    envelope: protocol.CommandEnvelope,
  ) {
    if (!envelope.sessionId)
      throw new CodeUiRepositoryError("not_found", "追问偏好缺少Task身份");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    if (loaded.entry.parent_session_id || loaded.project.path !== workspacePath)
      throw new CodeUiRepositoryError(
        "not_found",
        "追问偏好不属于该根Task与固定目录",
      );
    const { mode } = protocol.commandPayloadSchemas.setFollowupMode.parse(
      envelope.payload,
    );
    const ack = await this.deps.repository.applyCommand(
      loaded.instanceId,
      envelope,
      codeUiCommandFingerprint(envelope),
      (root) => {
        if (root.archived || root.execution_state !== "ready")
          throw new CodeUiRepositoryError(
            "command_conflict",
            "Task已关闭，不能修改追问偏好",
          );
        const state = structuredClone(root.state!);
        const snapshot = state.snapshots.find(
          (entry) => entry.sessionId === root.id,
        );
        if (!snapshot)
          throw new CodeUiRepositoryError("not_found", "Task根快照不存在");
        if (
          envelope.baseRevision !== snapshot.revision ||
          (envelope.baseLogEpoch !== undefined &&
            envelope.baseLogEpoch !== snapshot.logEpoch)
        )
          return {
            state,
            activeRunId: root.active_run_id,
            ack: {
              commandId: envelope.commandId,
              status: "rejected",
              reasonCode:
                envelope.baseRevision !== snapshot.revision
                  ? "proto.staleRevision"
                  : "proto.staleLogEpoch",
              message: "Task配置已经改变，请刷新后再修改追问偏好",
              revisionAtDecision: snapshot.revision,
            },
          };
        snapshot.config = { ...snapshot.config, followupMode: mode };
        snapshot.inputRouting = codeInputRouting(snapshot);
        snapshot.seq += 1;
        snapshot.revision += 1;
        return {
          state,
          activeRunId: root.active_run_id,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: snapshot.revision,
          },
        };
      },
    );
    return {
      result: ack,
      publish: publishOnce(async () => {
        if (ack.status !== "accepted") return;
        await this.refreshTaskProjection(
          loaded.instanceId,
          loaded.project.path,
          loaded.project.projectId,
        );
      }),
    };
  }

  private async switchMode(
    user: LocalActor,
    workspacePath: string,
    envelope: protocol.CommandEnvelope,
  ) {
    if (!envelope.sessionId)
      throw new CodeUiRepositoryError("not_found", "权限命令缺少 Task 身份");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    if (
      loaded.entry.parent_session_id ||
      loaded.project.path !== workspacePath
    ) {
      throw new CodeUiRepositoryError(
        "command_conflict",
        "只可在所属根 Task 调整执行权限",
      );
    }
    const { mode } =
      protocol.commandPayloadSchemas.switchCollaborationMode.parse(
        envelope.payload,
      );
    const sandboxMode =
      mode === "plan"
        ? "read-only"
        : mode === "yolo"
          ? "danger-full-access"
          : "workspace-write";
    const ack = await this.deps.repository.applyScopeCommand(
      loaded.instanceId,
      envelope,
      codeUiCommandFingerprint(envelope),
      async () => {
        await this.deps.executionScopes.updateTask(user, loaded.root.id, {
          sandboxMode,
        });
      },
      (root) => {
        const state = structuredClone(root.state!);
        const snapshot = state.snapshots.find(
          (item) => item.sessionId === root.id,
        );
        if (!snapshot)
          throw new CodeUiRepositoryError("not_found", "Task 根快照不存在");
        snapshot.config = {
          ...snapshot.config,
          mode,
          planEnabled: mode === "plan",
        };
        snapshot.seq += 1;
        snapshot.revision += 1;
        return {
          state,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: snapshot.revision,
          },
        };
      },
    );
    return {
      result: ack,
      publish: async () => {
        await this.refreshTaskProjection(
          loaded.instanceId,
          loaded.project.path,
          loaded.project.projectId,
        );
        await this.notifyTask(
          user,
          loaded.project,
          loaded.root.id,
          "task_status_changed",
        );
      },
    };
  }

  private async resolveInteraction(
    user: LocalActor,
    workspacePath: string,
    envelope: protocol.CommandEnvelope,
  ) {
    if (!envelope.sessionId)
      throw new CodeUiRepositoryError("not_found", "交互命令缺少 Task 身份");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    if (loaded.root.root_directory !== workspacePath)
      throw new CodeUiRepositoryError(
        "not_found",
        "审批命令不属于当前 Task 目录",
      );
    const payload = protocol.commandPayloadSchemas.resolveInteraction.parse(
      envelope.payload,
    );
    let resolution:
      | Awaited<ReturnType<PermissionService["resolve"]>>
      | UserInputResolutionResult
      | undefined;
    const ack = await this.deps.repository.applyScopeCommand(
      loaded.instanceId,
      { ...envelope, sessionId: loaded.root.id },
      codeUiCommandFingerprint(envelope),
      async (root) => {
        const question = this.userInputs?.find(
          loaded.instanceId,
          root.id,
          payload.interactionId,
        );
        const approval = this.deps.permissions?.find(
          loaded.instanceId,
          root.id,
          payload.interactionId,
        );
        const pending = question ?? approval;
        if (!pending) {
          resolution = { status: "rejected", reasonCode: "not_found" };
          return;
        }
        const ownerSessionId =
          pending.identity.agentId === "main"
            ? root.id
            : pending.identity.agentId;
        if (ownerSessionId !== loaded.entry.id)
          throw new CodeUiRepositoryError("not_found", "交互不属于该会话");
        const input = {
          interactionId: payload.interactionId,
          answer: payload.answer,
          binding: {
            instanceId: loaded.instanceId,
            taskId: root.id,
            runId: pending.identity.runId,
            scopeGeneration: Number(root.scope_generation),
            branchGeneration: Number(root.branch_generation),
            ...(approval?.identity.planningEpoch !== undefined ? {
              planningEpoch: root.state?.planningEpoch ?? 0,
              runId: root.active_run_id ?? "",
            } : {}),
          },
        };
        resolution = question
          ? await this.userInputs!.resolve(input)
          : await this.deps.permissions!.resolve(input);
      },
      (root) => ({
        state: root.state!,
        ack: {
          commandId: envelope.commandId,
          status: resolution?.status === "rejected" ? "rejected" : "accepted",
          revisionAtDecision: Number(root.revision),
          ...(resolution && "reasonCode" in resolution
            ? { reasonCode: resolution.reasonCode }
            : {}),
        },
      }),
    );
    return { result: ack };
  }

  private async stopExecution(
    user: LocalActor,
    envelope: protocol.CommandEnvelope,
  ) {
    if (!envelope.sessionId)
      throw new CodeUiRepositoryError("not_found", "停止缺少会话身份");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    const payload = protocol.commandPayloadSchemas.stop.parse(envelope.payload);
    const ack = await this.deps.repository.applyScopeCommand(
      loaded.instanceId,
      { ...envelope, sessionId: loaded.root.id },
      codeUiCommandFingerprint(envelope),
      async (root) => {
        const snapshot = root.state!.snapshots.find(
          (entry) => entry.sessionId === loaded.entry.id,
        );
        const execution =
          snapshot?.control.activeWorks.find(
            (work) =>
              work.kind === "primaryTurn" || work.kind === "foregroundSubagent",
          )?.foregroundExecutionId ??
          (loaded.entry.id === root.id
            ? (root.active_run_id ??
              root.state!.inputs?.find((entry) => entry.status === "reserved")
                ?.previousRunId ??
              null)
            : null);
        if (
          payload.expectedForegroundExecutionId &&
          payload.expectedForegroundExecutionId !== execution
        )
          return;
        if (loaded.entry.id === root.id)
          await this.deps.repository.appendEvent(
            loaded.instanceId,
            root.id,
            {
              key: `input-stop:${envelope.clientId}/${envelope.commandId}`,
              fingerprint: codeUiCommandFingerprint(envelope),
              event: { type: "input.stop", execution },
            },
            (current) => {
              const state = structuredClone(current.state!);
              const currentSnapshot = state.snapshots.find(
                (entry) => entry.sessionId === current.id,
              )!;
              const activeExecution =
                currentSnapshot.control.activeWorks.find(
                  (work) => work.kind === "primaryTurn",
                )?.foregroundExecutionId ??
                current.active_run_id ??
                state.inputs?.find((entry) => entry.status === "reserved")
                  ?.previousRunId;
              if (
                payload.expectedForegroundExecutionId &&
                payload.expectedForegroundExecutionId !== activeExecution
              )
                return { state, activeRunId: current.active_run_id };
              const stopped =
                state.inputs?.filter(
                  (entry) =>
                    entry.status === "reserved" &&
                    (!execution || entry.previousRunId === execution),
                ) ?? [];
              const settlements: CodeInputSettlement[] = stopped.map(
                (entry) => {
                  entry.status = "discarded";
                  currentSnapshot.pendingCommands =
                    currentSnapshot.pendingCommands.filter(
                      (pending) =>
                        pending.commandId !== entry.intent.sourceCommandId ||
                        pending.clientId !== entry.intent.clientId,
                    );
                  return {
                    clientId: entry.intent.clientId,
                    commandId: entry.intent.sourceCommandId,
                    ack: {
                      commandId: entry.intent.sourceCommandId,
                      status: "failed",
                      reasonCode: "fault.command.inputStopped",
                      revisionAtDecision: currentSnapshot.revision + 1,
                      result: {
                        type: "inputDisposition",
                        delivery: entry.intent.delivery.admitted,
                      },
                    },
                  };
                },
              );
              currentSnapshot.queue.autoDrain = false;
              currentSnapshot.queue.pauseReason = "stopped";
              currentSnapshot.seq += 1;
              currentSnapshot.revision += 1;
              return { state, activeRunId: current.active_run_id, settlements };
            },
          );
        if (execution) await this.deps.agentRuns.cancelRunAndWait(execution);
        if (execution && loaded.entry.id === root.id)
          await this.deps.repository.appendEvent(
            loaded.instanceId,
            root.id,
            {
              key: `input-stop-completed:${envelope.clientId}/${envelope.commandId}`,
              fingerprint: codeUiCommandFingerprint(envelope),
              event: { type: "input.stopped", execution },
            },
            (current) => {
              const currentSnapshot = current.state!.snapshots.find(
                (entry) => entry.sessionId === current.id,
              )!;
              const host = createCodeUiConversation({
                sessionId: current.id,
                workspacePath: current.root_directory!,
                config: currentSnapshot.config,
                state: current.state!,
              });
              // 尚未派发的输入同样有关闭事实；已持久终态由原会话 reducer 拒绝重复或旧Run回绕。
              host.recordEvent({
                type: "run.canceled",
                runId: execution,
                timestamp: new Date().toISOString(),
              });
              return {
                state: host.exportState(),
                activeRunId:
                  current.active_run_id === execution
                    ? null
                    : current.active_run_id,
              };
            },
          );
      },
      (root) => ({
        state: root.state!,
        ack: {
          commandId: envelope.commandId,
          status: "accepted",
          revisionAtDecision: Number(root.revision),
        },
      }),
    );
    return { result: ack };
  }

  private async cancelBackgroundWork(
    user: LocalActor,
    envelope: protocol.CommandEnvelope,
  ) {
    if (!envelope.sessionId)
      throw new CodeUiRepositoryError("not_found", "后台停止缺少 Task 身份");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    const payload = protocol.commandPayloadSchemas.cancelBackgroundWork.parse(
      envelope.payload,
    );
    const scope = await this.deps.executionScopes.openTask(
      user,
      loaded.root.id,
    );
    const context: TaskWorkContext = {
      actor: user,
      scope: scope.describe(),
      agentId: "main",
      runId: "human-stop",
      branchGeneration: Number(loaded.root.branch_generation),
    };
    const ack = await this.deps.repository.applyScopeCommand(
      loaded.instanceId,
      { ...envelope, sessionId: loaded.root.id },
      codeUiCommandFingerprint(envelope),
      async () => {
        const work = await this.deps.taskWork.find(context, payload.workId);
        if (!work)
          throw new CodeUiRepositoryError(
            "not_found",
            "后台工作不属于当前 Task",
          );
        if (work.status === "running")
          await this.deps.taskWork.stop(
            context,
            payload.workId,
            "用户停止后台工作",
          );
      },
      (root) => ({
        state: root.state!,
        ack: {
          commandId: envelope.commandId,
          status: "accepted",
          revisionAtDecision: Number(root.revision),
        },
      }),
    );
    return { result: ack };
  }

  private async queueCommand(
    user: LocalActor,
    workspacePath: string,
    envelope: protocol.CommandEnvelope,
  ) {
    if (!envelope.sessionId)
      throw new CodeUiRepositoryError("not_found", "队列命令缺少Task身份。");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    if (loaded.entry.parent_session_id || loaded.project.path !== workspacePath)
      throw new CodeUiRepositoryError(
        "not_found",
        "队列命令不属于根Task工作目录。",
      );
    let dispatch: CodeAdmittedInput | undefined;
    const ack = await this.deps.repository.applyCommand(
      loaded.instanceId,
      envelope,
      codeUiCommandFingerprint(envelope),
      (root) => {
        if (root.archived || root.execution_state !== "ready")
          throw new CodeUiRepositoryError(
            "command_conflict",
            "Task已关闭，不能调整队列。",
          );
        const state = structuredClone(root.state!);
        const result = applyCodeQueueCommand(state, root.id, envelope);
        dispatch = result.dispatch;
        return {
          state,
          activeRunId: root.active_run_id,
          ack: result.ack,
          settlements: result.settlements,
        };
      },
    );
    return {
      result: ack,
      publish: async () => {
        await this.refreshTaskProjection(
          loaded.instanceId,
          workspacePath,
          loaded.project.projectId,
        );
        if (
          ack.status === "accepted" &&
          dispatch &&
          (await this.preemptInput(user, loaded.root.id, dispatch))
        ) {
          const codeInputs = dispatch.intent.attachments.length
            ? await this.attachments!.readForInput(
                user,
                loaded.root.id,
                dispatch.intent.attachments,
              )
            : [];
          const thread = await this.deps.threads.resolveOwnedSessionThread(
            user,
            loaded.root.id,
          );
          const selection = dispatch.intent.modelSelection!;
          await this.runTurn(
            user,
            loaded.project,
            loaded.root.id,
            thread.threadId,
            dispatch.runId,
            dispatch.intent.text,
            `${selection.providerId}:${selection.modelId}`,
            dispatch.modelInvocation,
            codeInputs,
          );
          return;
        }
        if (ack.status === "accepted")
          await this.drainQueuedInput(user, loaded.root.id);
      },
    };
  }

  private async sendText(
    user: LocalActor,
    workspacePath: string,
    envelope: protocol.CommandEnvelope,
  ) {
    const release = this.deps.localInstance.beginAdmission();
    try {
      return await this.admitText(user, workspacePath, envelope);
    } finally {
      release();
    }
  }

  consumeGuides(context: ToolExecutionContext) {
    return this.guideInputs.consumeGuides(context);
  }

  enterPlanMode(context: ToolExecutionContext) {
    return this.planning.enter(context);
  }

  exitPlanMode(context: ToolExecutionContext) {
    return this.planning.exit(context);
  }

  readApprovedPlan(context: PromptExecutionContext) {
    return this.approvedPlans.read(context);
  }

  hasPendingGuides(context: ToolExecutionContext) {
    return this.guideInputs.hasPendingGuides(context);
  }

  private async admitText(
    user: LocalActor,
    workspacePath: string,
    envelope: protocol.CommandEnvelope,
  ) {
    if (!envelope.sessionId)
      throw new CodeUiRepositoryError("not_found", "发送命令缺少会话");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    if (loaded.entry.parent_session_id || loaded.project.path !== workspacePath)
      throw new CodeUiRepositoryError(
        "not_found",
        "发送命令不属于根会话工作目录",
      );
    const compact = envelope.type === "compact";
    if (compact) protocol.commandPayloadSchemas.compact.parse(envelope.payload);
    const payload = protocol.commandPayloadSchemas.sendText.parse(
      compact ? { text: "" } : envelope.payload,
    );
    if (!compact && !payload.text.trim() && !payload.attachments?.length)
      throw new CodeUiRepositoryError("command_conflict", "消息不能为空");
    if (payload.attachments?.length && !this.attachments)
      throw new CodeAttachmentError(
        "fault.attachment.unavailable",
        "Code附件存储不可用。",
        503,
      );
    if (payload.attachments?.length) this.attachmentsUsed = true;
    const codeInputs = payload.attachments?.length
      ? await this.attachments!.readForInput(
          user,
          loaded.root.id,
          payload.attachments,
        )
      : [];
    const snapshot = loaded.host.getSnapshot();
    const { selection, modelInvocation } = await this.prepareInputModel(
      user,
      payload.modelSelection !== undefined
        ? payload.modelSelection
        : snapshot.config.modelSelection,
    );
    const thread = await this.deps.threads.resolveOwnedSessionThread(
      user,
      loaded.root.id,
    );
    const runId = randomUUID();
    const ack = await this.deps.repository.applyCommand(
      loaded.instanceId,
      envelope,
      // 运行身份来自本次事务；忙时立即发送先只认领，停止确认后才投影新一轮。
      codeUiCommandFingerprint(envelope),
      (root) => {
        const host = createCodeUiConversation({
          sessionId: root.id,
          workspacePath,
          config: snapshot.config,
          state: root.state!,
        });
        if (
          root.archived ||
          root.execution_state !== "ready" ||
          Number(root.scope_generation) !==
            Number(loaded.root.scope_generation) ||
          Number(root.branch_generation) !==
            Number(loaded.root.branch_generation)
        )
          throw new CodeUiRepositoryError(
            "command_conflict",
            "Task已关闭或工作域改变，请重新提交输入。",
          );
        const current = host.getSnapshot();
        if (
          root.state?.inputOwner &&
          root.state.inputOwner.hostId !== this.inputOwner.hostId &&
          (root.active_run_id || current.queue.items.length)
        )
          throw new CodeUiRepositoryError(
            "command_conflict",
            "Task输入仍由其它执行宿主持有，请在原宿主完成或关闭运行。",
          );
        const busy = current.control.phase === "running";
        if (
          payload.requestedDelivery === "startNow" &&
          root.state?.inputs?.some((record) => record.status === "reserved")
        )
          return {
            state: root.state,
            activeRunId: root.active_run_id,
            ack: {
              commandId: envelope.commandId,
              status: "rejected",
              reasonCode: "guard.preemptionPending",
              revisionAtDecision: current.revision,
            },
          };
        const preempt = busy && payload.requestedDelivery === "startNow";
        const previous =
          root.active_run_id ??
          current.control.activeWorks.find(
            (work) => work.kind === "primaryTurn",
          )?.foregroundExecutionId;
        if (preempt && !previous)
          throw new CodeUiRepositoryError(
            "command_conflict",
            "前台运行身份不可用，不能安全抢占。",
          );
        const active = root.state?.inputs?.find(
          (input) => input.runId === previous && input.status === "active",
        );
        const requestedGuide = !compact && busy &&
          (payload.requestedDelivery === "guide" ||
            (payload.requestedDelivery === undefined &&
              current.config.followupMode === "guide"));
        const guide =
          requestedGuide &&
          !!previous &&
          active?.intent.kind === "sendText" &&
          !codeInputs.length;
        const delivery = guide
          ? "guide"
          : (!preempt && busy) ||
              payload.requestedDelivery === "queue" ||
              (compact &&
                !current.queue.autoDrain &&
                current.queue.items.length > 0)
            ? "queue"
            : "startNow";
        let settlements: CodeInputSettlement[] = [];
        if (
          !busy &&
          delivery === "startNow" &&
          !current.queue.autoDrain &&
          current.queue.items.length
        ) {
          const held = host.resolveHeldQueue(payload);
          if (!held.ok)
            return {
              state: root.state!,
              activeRunId: root.active_run_id,
              ack: {
                commandId: envelope.commandId,
                status: "rejected",
                reasonCode: held.reasonCode,
                message: held.message,
                revisionAtDecision: current.revision,
              },
            };
          settlements = held.settlements;
        }
        // 在接纳边界用原resolver固定别名语义；不能先用current补flag再解释raw plan。
        const currentExecution = resolveExecutionState({
          mode: current.config.mode,
          ...(current.config.planEnabled !== undefined
            ? { planEnabled: current.config.planEnabled }
            : {}),
        });
        const execution = resolveExecutionState(
          {
            ...(payload.mode !== undefined
              ? {
                  mode: protocol.commandPayloadSchemas.switchCollaborationMode.parse(
                    { mode: payload.mode },
                  ).mode,
                }
              : {}),
            ...(payload.planEnabled !== undefined
              ? { planEnabled: payload.planEnabled }
              : {}),
          },
          currentExecution,
        );
        const intent: protocol.ConversationInputIntent = {
          sourceCommandId: envelope.commandId,
          queueItemId: randomUUID(),
          clientId: envelope.clientId,
          kind: compact ? "compact" : "sendText",
          text: payload.text,
          attachments: codeInputs.map((input) => input.attachment),
          modelSelection: selection,
          mode: protocol.commandPayloadSchemas.switchCollaborationMode.parse({
            mode: execution.mode,
          }).mode,
          planEnabled: execution.planEnabled,
          delivery: {
            requested: payload.requestedDelivery ?? "auto",
            admitted: delivery,
          },
          order: {
            admissionSeq:
              (root.state?.inputs?.at(-1)?.intent.order.admissionSeq ?? 0) + 1,
            ...(delivery === "queue"
              ? { queuePosition: current.queue.items.length }
              : {}),
          },
          steer: {
            state:
              guide ? "steering" : payload.requestedDelivery === "guide"
                ? "fellBack"
                : "notRequested",
            ...(payload.requestedDelivery === "guide" && !guide
              ? { reasonCode: "guard.steeringUnavailable" }
              : {}),
          },
          dispatch: {
            state: preempt
              ? "reserved"
              : delivery === "queue" || delivery === "guide"
                ? "queued"
                : "admitted",
            ...(preempt ? { reservationId: runId } : {}),
          },
          admittedAt: Date.now(),
        };
        const record: CodeAdmittedInput = {
          intent,
          runId: guide ? previous! : runId,
          modelInvocation,
          scopeGeneration: Number(root.scope_generation),
          branchGeneration: Number(root.branch_generation),
          status: preempt
            ? "reserved"
            : delivery === "queue" || delivery === "guide"
              ? "queued"
              : "active",
          ...(preempt
            ? {
                autoDrainAtAdmission: current.queue.autoDrain,
                previousRunId: previous!,
              }
            : {}),
        };
        host.admitInput(record, this.inputOwner);
        if (delivery === "startNow" && !preempt) host.startInput(record);
        return {
          state: host.exportState(),
          activeRunId:
            delivery === "startNow" && !preempt ? runId : root.active_run_id,
          settlements,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: host.getSnapshot().revision,
            result: {
              type: "inputAccepted",
              delivery: delivery === "guide" ? "queue" : delivery,
              inputId: envelope.commandId,
            },
          },
        };
      },
    );
    return {
      result: ack,
      publish: publishOnce(async () => {
        if (ack.status !== "accepted") return;
        await this.refreshTaskProjection(
          loaded.instanceId,
          workspacePath,
          loaded.project.projectId,
        );
        await this.notifyTask(
          user,
          loaded.project,
          loaded.root.id,
          compact ? "task_status_changed" : "user_message_saved",
        );
        if (
          (ack.result as { delivery?: string } | undefined)?.delivery ===
          "queue"
        ) {
          await this.drainQueuedInput(user, loaded.root.id);
          return;
        }
        const accepted = await this.deps.repository.find(
          loaded.instanceId,
          loaded.root.id,
        );
        const record = accepted?.state?.inputs?.find(
          (entry) => entry.runId === runId,
        );
        if (
          !record ||
          (record.status !== "reserved" && record.status !== "active")
        )
          return;
        if (
          record?.status === "reserved" &&
          !(await this.preemptInput(user, loaded.root.id, record))
        )
          return;
        await this.runTurn(
          user,
          loaded.project,
          loaded.root.id,
          thread.threadId,
          runId,
          payload.text,
          `${selection.providerId}:${selection.modelId}`,
          modelInvocation,
          codeInputs,
        );
      }),
    };
  }

  private async preemptInput(
    user: LocalActor,
    taskId: string,
    reservation: CodeAdmittedInput,
  ): Promise<boolean> {
    if (reservation.previousRunId)
      await this.deps.agentRuns.cancelRunAndWait(reservation.previousRunId);
    const loaded = await this.loadConversation(user, taskId);
    let selected = false;
    await this.deps.repository.appendEvent(
      loaded.instanceId,
      taskId,
      {
        key: `input-preempt:${reservation.runId}`,
        fingerprint: reservation.runId,
        event: { type: "input.preempt", runId: reservation.runId },
      },
      (root) => {
        const state = structuredClone(root.state!);
        const record = state.inputs?.find(
          (entry) =>
            entry.runId === reservation.runId && entry.status === "reserved",
        );
        if (!record) return { state, activeRunId: root.active_run_id };
        const snapshot = state.snapshots.find(
          (entry) => entry.sessionId === root.id,
        )!;
        if (
          root.archived ||
          root.execution_state !== "ready" ||
          record.scopeGeneration !== Number(root.scope_generation) ||
          record.branchGeneration !== Number(root.branch_generation)
        ) {
          record.status = "discarded";
          snapshot.pendingCommands = snapshot.pendingCommands.filter(
            (entry) =>
              entry.commandId !== record.intent.sourceCommandId ||
              entry.clientId !== record.intent.clientId,
          );
          snapshot.seq += 1;
          snapshot.revision += 1;
          return {
            state,
            activeRunId: root.active_run_id,
            settlements: [
              {
                clientId: record.intent.clientId,
                commandId: record.intent.sourceCommandId,
                ack: {
                  commandId: record.intent.sourceCommandId,
                  status: "failed",
                  reasonCode: "fault.command.inputInvalidated",
                  revisionAtDecision: snapshot.revision,
                  result: { type: "inputDisposition", delivery: "startNow" },
                },
              },
            ],
          };
        }
        const host = createCodeUiConversation({
          sessionId: root.id,
          workspacePath: root.root_directory!,
          config: snapshot.config,
          state,
        });
        // 旧终态持久化缺失时，真正cancelRunAndWait返回提供关闭事实；只可关闭这次预占的旧Run。
        if (root.active_run_id === reservation.previousRunId)
          host.recordEvent({
            type: "run.canceled",
            runId: reservation.previousRunId!,
            timestamp: new Date().toISOString(),
          });
        selected = host.promoteReservedInput(reservation.runId) !== undefined;
        return {
          state: host.exportState(),
          activeRunId: selected ? reservation.runId : root.active_run_id,
        };
      },
    );
    return selected;
  }

  private async recordRunEvent(
    user: LocalActor,
    project: CodeUiWorkspace,
    sessionId: string,
    event: StreamEvent,
    ordinal: number,
  ) {
    const workspace = await this.deps.localInstance.resolve(user);
    const applied = await this.deps.repository.appendEvent(
      workspace.instanceId,
      sessionId,
      {
        key: `${event.runId}/${ordinal}`,
        fingerprint: createHash("sha256")
          .update(canonical(event))
          .digest("hex"),
        event,
      },
      (root) => {
        const rootSnapshot = root.state!.snapshots.find(
          (entry) => entry.sessionId === root.id,
        )!;
        const host = createCodeUiConversation({
          sessionId: root.id,
          workspacePath: project.path,
          config: rootSnapshot.config,
          state: root.state!,
        });
        host.recordEvent(event);
        const state = host.exportState();
        return {
          state,
          activeRunId:
            host.getSnapshot().control.phase === "running"
              ? (host
                  .getSnapshot()
                  .control.activeWorks.find(
                    (work) => work.kind === "primaryTurn",
                  )?.foregroundExecutionId ?? root.active_run_id)
              : null,
        };
      },
    );
    if (applied) {
      await this.refreshTaskProjection(
        workspace.instanceId,
        project.path,
        project.projectId,
      );
      if (["run.completed", "run.failed", "run.canceled"].includes(event.type))
        await this.notifyTask(user, project, sessionId, "task_status_changed");
    }
  }

  private async notifyTask(
    user: LocalActor,
    project: CodeUiWorkspace,
    sessionId: string,
    reason: "task_created" | "user_message_saved" | "task_status_changed",
  ) {
    const workspace = await this.deps.localInstance.resolve(user);
    const record = await this.deps.repository.find(
      workspace.instanceId,
      sessionId,
    );
    const meta = record
      ? codeUiTaskMeta(record, record.root_directory ?? project.path)
      : null;
    if (!meta) return;
    try {
      const current = (await this.listWorkspaces(user)).find(
        (entry) => entry.projectId === project.projectId,
      );
      const paths = new Set([
        record?.root_directory ?? project.path,
        current?.path ?? project.path,
      ]);
      const workspaceIdentity = JSON.stringify([
        project.projectId,
        record?.root_directory ?? project.path,
      ]);
      const data = {
        type: "workspace_task_list_changed",
        workspacePath: record?.root_directory ?? project.path,
        workspaceIdentity,
        taskId: sessionId,
        reason,
        taskMeta: { ...meta, workspaceIdentity },
      };
      for (const controller of this.controllers.values())
        if (controller.instanceId === workspace.instanceId)
          controller.host.accept({
            event: "service",
            service: "zcode-task",
            name: "onDynamicWorkspaceEvent",
            workspacePath: data.workspacePath,
            workspaceIdentity,
            data,
          });
      await Promise.all(
        [...paths].map((path) =>
          this.connections.notify(
            workspace.instanceId,
            "zcode-task",
            "onDynamicWorkspaceEvent",
            path,
            {
              ...data,
              workspacePath: path,
            },
            workspaceIdentity,
          ),
        ),
      );
    } catch (error) {
      console.warn("[code-ui] Task 事实已持久化，侧栏通知失败：", error);
    }
  }

  private async runTurn(
    user: LocalActor,
    project: CodeUiWorkspace,
    sessionId: string,
    threadId: string,
    runId: string,
    text: string,
    model: string,
    modelInvocation?: ModelInvocationSnapshot,
    codeInputs?: TrustedCodeInput[],
    backgroundInputIdentity?: { clientId: string; sourceCommandId: string },
  ) {
    let ordinal = 0;
    try {
      if (this.closing)
        throw new CodeUiRepositoryError(
          "command_conflict",
          "执行宿主已关闭，不能启动新运行。",
        );
      const scopeHandle = await this.deps.executionScopes.openTask(
        user,
        sessionId,
      );
      const current = await this.deps.repository.find(
        scopeHandle.describe().instanceId,
        sessionId,
      );
      if (!current)
        throw new CodeUiRepositoryError(
          "not_found",
          "Code Task 已删除或不存在。",
        );
      this.taskActors.set(
        JSON.stringify([scopeHandle.describe().instanceId, sessionId]),
        user,
      );
      await this.deps.agentRunMetadata.createAcceptedRun({
        runId,
        sessionId,
        threadId,
        model,
      });
      const started = await this.deps.repository.startRunIfCurrent(
        scopeHandle.describe().instanceId,
        sessionId,
        runId,
        {
          scopeGeneration: scopeHandle.describe().generation,
          branchGeneration: Number(current.branch_generation),
          inputRequired: backgroundInputIdentity === undefined,
        },
        (root) => {
          const currentInput = root.state!.inputs?.find(
            (entry) => entry.runId === runId,
          );
          this.deps.agentRuns.createRun(
            {
              sessionId,
              conversationId: sessionId,
              projectId: project.projectId,
              taskId: sessionId,
              preset: "code",
              prompt: text,
              model,
            },
            {
              runId,
              threadId,
              scopeHandle,
              actor: user,
              model,
              ...(modelInvocation ? { modelInvocation } : {}),
              ...(codeInputs?.length ? { codeInputs } : {}),
              ...(currentInput
                ? {
                    inputIdentity: {
                      clientId: currentInput.intent.clientId,
                      sourceCommandId: currentInput.intent.sourceCommandId,
                    },
                    inputOrigin:
                      currentInput.intent.kind === "compact"
                        ? ("controlOperation" as const)
                        : ("userInput" as const),
                    ...(currentInput.intent.kind === "compact"
                      ? { operation: { kind: "compact" as const } }
                      : {}),
                  }
                : backgroundInputIdentity
                  ? {
                      inputIdentity: { ...backgroundInputIdentity },
                      inputOrigin: "backgroundResult" as const,
                    }
                  : {}),
              ...(currentInput?.intent.mode
                ? {
                    approvalCeiling: currentInput.intent.planEnabled
                      ? ("plan" as const)
                      : currentInput.intent.mode,
                  }
                : {}),
              eventSink: (event) =>
                this.recordRunEvent(user, project, sessionId, event, ++ordinal),
            },
          );
        },
      );
      if (!started) {
        await this.deps.agentRunMetadata.updateRun({
          runId,
          status: "canceled",
          completedAt: new Date().toISOString(),
        });
        // accepted输入可能在真实派发前被撤权；原事件消费者同时结算输入与V4。
        // 如果更新的Run已接管，consumer按runId忽略旧终态，不中断新运行。
        await this.recordRunEvent(
          user,
          project,
          sessionId,
          { type: "run.canceled", runId, timestamp: new Date().toISOString() },
          ++ordinal,
        );
        return;
      }
      for await (const _event of this.deps.agentRuns.streamRun(runId)) {
        /* 持久事件由共享 Harness eventSink 投影。 */
      }
    } catch (error) {
      this.deps.agentRuns.cancelRun(runId);
      if (error instanceof CodeUiRepositoryError && error.code === "not_found")
        return;
      await this.recordRunEvent(
        user,
        project,
        sessionId,
        {
          type: "run.failed",
          runId,
          error: {
            code: "run_failed",
            message: error instanceof Error ? error.message : "Code 运行失败",
          },
          timestamp: new Date().toISOString(),
        },
        ++ordinal,
      );
    } finally {
      // streamRun 的 finally 已释放真实前台租约；终态 eventSink 内不可提前启动下一轮。
      try {
        await this.fileHistory.refreshAvailability(user, sessionId, runId);
      } catch (error) {
        console.warn("[code-ui] 轮次文件恢复能力刷新失败：", error);
      }
      await this.drainQueuedInput(user, sessionId);
      // 前台释放时公共Task还未完成；完成投影/用户队列调度后再唤醒持久后台通知。
      await this.deps.taskWork
        .notifyReady(user.instanceId, sessionId)
        .catch((error: unknown) => {
          console.warn("[code-ui] Run收尾后的后台通知 admission失败：", error);
        });
    }
  }

  private async drainQueuedInput(
    user: LocalActor,
    taskId: string,
  ): Promise<void> {
    if (this.closing) return;
    let loaded: Awaited<ReturnType<CodeUiService["loadConversation"]>>;
    try {
      loaded = await this.loadConversation(user, taskId);
    } catch (error) {
      if (error instanceof CodeUiRepositoryError && error.code === "not_found")
        return;
      throw error;
    }
    const snapshot = loaded.host.getSnapshot();
    if (
      loaded.root.active_run_id ||
      !snapshot.queue.autoDrain ||
      !snapshot.queue.items.length ||
      loaded.root.archived ||
      loaded.root.execution_state !== "ready"
    )
      return;
    let selected: CodeAdmittedInput | undefined;
    const reservationId = randomUUID();
    await this.deps.repository.appendEvent(
      loaded.instanceId,
      taskId,
      {
        key: `input-claim:${reservationId}`,
        fingerprint: reservationId,
        event: { type: "input.claim", reservationId },
      },
      (root) => {
        const current = root.state!.snapshots.find(
          (item) => item.sessionId === root.id,
        )!;
        const host = createCodeUiConversation({
          sessionId: root.id,
          workspacePath: root.root_directory!,
          config: current.config,
          state: root.state!,
        });
        if (
          !root.active_run_id &&
          !root.archived &&
          root.execution_state === "ready" &&
          !root.state?.inputs?.some((record) => record.status === "reserved")
        )
          selected = host.promoteQueuedInput(
            Number(root.scope_generation),
            Number(root.branch_generation),
            reservationId,
          );
        return {
          state: host.exportState(),
          activeRunId: selected?.runId ?? root.active_run_id,
        };
      },
    );
    if (!selected) return;
    try {
      const codeInputs = selected.intent.attachments.length
        ? await this.attachments!.readForInput(
            user,
            taskId,
            selected.intent.attachments,
          )
        : [];
      const thread = await this.deps.threads.resolveOwnedSessionThread(
        user,
        taskId,
      );
      const selection = selected.intent.modelSelection!;
      void this.runTurn(
        user,
        loaded.project,
        taskId,
        thread.threadId,
        selected.runId,
        selected.intent.text,
        `${selection.providerId}:${selection.modelId}`,
        selected.modelInvocation,
        codeInputs,
      ).catch((error: unknown) =>
        console.error("[code-ui] 队列运行收口失败：", error),
      );
    } catch (error) {
      await this.recordRunEvent(
        user,
        loaded.project,
        taskId,
        {
          type: "run.failed",
          runId: selected.runId,
          timestamp: new Date().toISOString(),
          error: {
            code: "run_failed",
            message:
              error instanceof Error ? error.message : "排队输入准备失败。",
          },
        },
        1,
      );
    }
  }

  async listWorkspaces(user: LocalActor): Promise<CodeUiWorkspace[]> {
    const projects = await this.deps.projects.listProjects(user, "code");
    return projects.flatMap((project) =>
      project.kind === "code"
        ? [
            {
              projectId: project.id,
              name: project.name,
              path: project.workDir,
              additionalDirectories: project.additionalDirectories,
            },
          ]
        : [],
    );
  }

  async requireWorkspace(
    user: LocalActor,
    path: string,
  ): Promise<CodeUiWorkspace> {
    const projects = await this.listWorkspaces(user);
    const explicit = projects.find((candidate) => candidate.projectId === path);
    if (explicit) return explicit;
    const matches = projects.filter((candidate) => candidate.path === path);
    if (matches.length > 1)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "多个 Code 项目共享此目录，请明确提供项目身份。",
      );
    if (matches[0]) return matches[0];
    throw new CodeUiRepositoryError(
      "not_found",
      "Code 工作目录不属于当前工作区或已经归档",
    );
  }

  async refreshWorkspaceConfiguration(instanceId: string, projectId?: string) {
    const failures = await this.workspaceConfig.refresh(instanceId, projectId);
    for (const failure of failures) {
      failure.dispose();
      console.warn(
        "[code-ui] 工作区配置源已失效，精确订阅已释放：",
        failure.error,
      );
    }
  }

  private async resolveConfigTarget(
    actor: LocalActor,
    request: CodeUiWorkspaceConfigRequest,
  ): Promise<CodeUiWorkspaceConfigTarget> {
    const workspace = await this.deps.localInstance.resolve(actor);
    const projects = await this.listWorkspaces(actor);
    const candidates = projects.filter(
      (project) =>
        (!request.projectId || request.projectId === project.projectId) &&
        (request.workspaceIdentity
          ? request.workspaceIdentity === project.projectId ||
            request.workspaceIdentity ===
              JSON.stringify([project.projectId, request.workspacePath])
          : request.projectId || project.path === request.workspacePath),
    );
    if (candidates.length !== 1)
      throw new CodeUiRepositoryError(
        candidates.length ? "command_conflict" : "not_found",
        "配置目录需要明确且可见的Code项目身份。",
      );
    const project = candidates[0]!;
    if (
      project.path !== request.workspacePath &&
      !(await this.deps.repository.listRoots(workspace.instanceId)).some(
        (root) =>
          root.project_id === project.projectId &&
          root.root_directory === request.workspacePath &&
          !root.parent_session_id &&
          !root.deleted_at,
      )
    )
      throw new CodeUiRepositoryError(
        "not_found",
        "配置目录没有该Project默认目录或固定Task来源。",
      );
    return {
      instanceId: workspace.instanceId,
      projectId: project.projectId,
      workspacePath: request.workspacePath,
    };
  }

  private async readWorkspaceConfiguration(
    actor: LocalActor,
    target: CodeUiWorkspaceConfigTarget,
  ) {
    const settings = await this.deps.settings.getInstanceSettings(
      actor,
      target.instanceId,
    );
    return {
      mode: "build",
      slashCommands: settings.commands.map((command) => ({
        name: command.name,
        description: command.description,
        source: "custom" as const,
      })),
    };
  }

  private async resolveHostTarget(
    actor: LocalActor,
    request: CodeUiHostTargetRequest,
  ) {
    const workspace = await this.deps.localInstance.resolve(actor);
    if (request.viewerScope?.kind === "task") {
      const loaded = await this.loadConversation(
        actor,
        request.viewerScope.taskId,
      );
      const identities = [
        loaded.project.projectId,
        JSON.stringify([loaded.project.projectId, loaded.project.path]),
      ];
      if (
        loaded.entry.parent_session_id ||
        loaded.project.path !== request.workspacePath ||
        (request.workspaceIdentity &&
          !identities.includes(request.workspaceIdentity))
      )
        throw new CodeUiRepositoryError(
          "not_found",
          "宿主能力目标与Task身份不匹配。",
        );
      return {
        instanceId: workspace.instanceId,
        projectId: loaded.project.projectId,
        rootDirectory: loaded.project.path,
        viewerScope: request.viewerScope,
      };
    }
    const projectId =
      request.viewerScope?.kind === "project"
        ? request.viewerScope.projectId
        : (await this.listWorkspaces(actor)).find(
            (project) =>
              request.workspaceIdentity === project.projectId ||
              request.workspaceIdentity ===
                JSON.stringify([project.projectId, project.path]),
          )?.projectId;
    if (!projectId)
      throw new CodeUiRepositoryError(
        "not_found",
        "宿主能力需要明确的Project或Task身份。",
      );
    const project = await this.requireWorkspace(actor, projectId);
    if (
      project.path !== request.workspacePath ||
      (request.workspaceIdentity &&
        ![
          project.projectId,
          JSON.stringify([project.projectId, project.path]),
        ].includes(request.workspaceIdentity))
    )
      throw new CodeUiRepositoryError(
        "not_found",
        "宿主能力目标与Project身份不匹配。",
      );
    return {
      instanceId: workspace.instanceId,
      projectId: project.projectId,
      rootDirectory: project.path,
      viewerScope: { kind: "project" as const, projectId: project.projectId },
    };
  }

  private async resolveWatchTarget(
    actor: LocalActor,
    viewerScope: import("@kenfutwork/shared").CodeUiViewerScope,
    path: string,
  ) {
    if (viewerScope.kind === "task") {
      const scope = await this.deps.executionScopes.openTask(
        actor,
        viewerScope.taskId,
      );
      const identity = scope.describe();
      return {
        instanceId: identity.instanceId,
        projectId: identity.projectId,
        rootDirectory: identity.rootDirectory,
        generation: identity.generation,
        viewerScope,
        path: await scope.resolvePath(path, "read"),
      };
    }
    const project = await this.requireWorkspace(actor, viewerScope.projectId);
    const workspace = await this.deps.localInstance.resolve(actor);
    return {
      instanceId: workspace.instanceId,
      projectId: project.projectId,
      rootDirectory: project.path,
      viewerScope,
      path: await resolveReadOnlyProjectPath(
        {
          rootDirectory: project.path,
          additionalDirectories: project.additionalDirectories,
        },
        path,
      ),
    };
  }

  async modelViews(
    user: LocalActor,
    selection?: protocol.SessionConfigState["modelSelection"] | null,
  ) {
    return this.providerSettings.readViews(user, selection);
  }

  private async prepareInputModel(
    user: LocalActor,
    selection: protocol.SessionConfigState["modelSelection"],
  ) {
    const views = await this.modelViews(user, selection);
    const effective = views.selection.effectiveSelection;
    if (!effective)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "当前模型不可执行，请检查供应商配置",
      );
    return {
      selection: effective,
      modelInvocation: await this.prepareModelInvocation(user, effective),
    };
  }

  private async prepareModelInvocation(
    user: LocalActor,
    selection: NonNullable<protocol.SessionConfigState["modelSelection"]>,
  ): Promise<ModelInvocationSnapshot> {
    const [instances, catalog] = await Promise.all([
      this.deps.modelProviders.listInstances(user),
      this.deps.modelCatalog.listCatalog(user),
    ]);
    return compileCodeUiModelExecution({ instances, catalog, selection });
  }

  async createSession(
    user: LocalActor,
    envelope: protocol.CommandEnvelope,
  ): Promise<protocol.CommandAck> {
    const release = this.deps.localInstance.beginAdmission();
    try {
      return await this.createAdmittedSession(user, envelope);
    } finally {
      release();
    }
  }

  private async createAdmittedSession(
    user: LocalActor,
    envelope: protocol.CommandEnvelope,
  ): Promise<protocol.CommandAck> {
    await this.initialize();
    const payload = protocol.commandPayloadSchemas.createSession.parse(
      envelope.payload,
    );
    const project = await this.requireWorkspace(user, payload.workspaceId);
    const workspace = await this.deps.localInstance.resolve(user);
    const views = await this.modelViews(user, payload.config?.modelSelection);
    const selection =
      payload.config?.modelSelection ?? views.selection.preferredSelection;
    const sessionId = randomUUID();
    const record = await this.deps.projects.getProject(user, project.projectId);
    const additionalDirectories = record.additional_directories ?? [];
    const rootDirectory = await resolveProjectWorkDirectory({
      instanceId: workspace.instanceId,
      projectId: project.projectId,
      sandboxRoot: this.deps.env.sandboxRoot ?? DEFAULT_SANDBOX_ROOT,
      workDir: record.work_dir,
    });
    const host = createCodeUiConversation({
      sessionId,
      workspacePath: rootDirectory,
      config: {
        provider: "zcode",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
        ...(selection ? { modelSelection: selection } : {}),
        followupMode: payload.config?.followupMode ?? "queue",
        mode: payload.config?.mode ?? "build",
        planEnabled: payload.config?.planEnabled ?? false,
      },
    });
    return this.deps.repository.createRoot(workspace.instanceId, {
      sessionId,
      projectId: project.projectId,
      scope: {
        instanceId: workspace.instanceId,
        projectId: project.projectId,
        taskId: sessionId,
        generation: 0,
        rootDirectory,
        additionalDirectories,
        sandboxMode:
          host.getSnapshot().config.mode === "plan"
            ? "read-only"
            : host.getSnapshot().config.mode === "yolo"
              ? "danger-full-access"
              : "workspace-write",
      } satisfies CodeExecutionScope,
      createdByClientId: user.accessClientId,
      threadId: this.deps.threads.createThreadId(),
      state: host.exportState(),
      command: {
        clientId: envelope.clientId,
        commandId: envelope.commandId,
        fingerprint: codeUiCommandFingerprint(envelope),
      },
    });
  }

  async loadConversation(user: LocalActor, sessionId: string) {
    await this.initialize();
    const workspace = await this.deps.localInstance.resolve(user);
    const entry = await this.deps.repository.find(
      workspace.instanceId,
      sessionId,
    );
    if (!entry)
      throw new CodeUiRepositoryError("not_found", "Code 会话不存在或已删除");
    const root =
      entry.id === entry.root_session_id
        ? entry
        : await this.deps.repository.find(
            workspace.instanceId,
            entry.root_session_id,
          );
    if (!root?.state)
      throw new CodeUiRepositoryError("not_found", "Code 会话权威状态不存在");
    const currentProject = (await this.listWorkspaces(user)).find(
      (item) => item.projectId === root.project_id,
    );
    if (!currentProject || !root.root_directory)
      throw new CodeUiRepositoryError("not_found", "Code 项目已归档");
    const project = {
      ...currentProject,
      path: root.root_directory,
      additionalDirectories: root.additional_directories ?? [],
    };
    const snapshot = root.state.snapshots.find(
      (item) => item.sessionId === root.id,
    );
    if (!snapshot) throw new Error("Code 根快照缺失，无法恢复");
    const host = createCodeUiConversation({
      sessionId: root.id,
      workspacePath: project.path,
      config: snapshot.config,
      state: root.state,
    });
    return { instanceId: workspace.instanceId, project, entry, root, host };
  }

  async getSnapshot(user: LocalActor, sessionId: string) {
    const loaded = await this.loadConversation(user, sessionId);
    this.taskActors.set(
      JSON.stringify([loaded.instanceId, loaded.root.id]),
      user,
    );
    const snapshot = loaded.host.getSnapshot(sessionId);
    await this.historyEdit.decorate(user, loaded, snapshot);
    if (snapshot.backgroundWorks.some((work) => work.status !== "running")) {
      void this.deps.taskWork
        .notifyReady(loaded.instanceId, loaded.root.id)
        .catch((error: unknown) =>
          console.warn("[code-ui] 后台通知 admission 失败：", error),
        );
    }
    return snapshot;
  }

  async sessionsIndex(
    user: LocalActor,
    path: string,
    projectId?: string,
    workspaceIdentity?: string,
  ) {
    const project = await this.requireWorkspace(user, projectId ?? path);
    const workspace = await this.deps.localInstance.resolve(user);
    const records = await this.deps.repository.list(
      workspace.instanceId,
      project.projectId,
    );
    return protocol.sessionsIndexSnapshotSchema.parse({
      protocolVersion: 1,
      workspaceId: workspaceIdentity ?? path,
      logEpoch: workspace.instanceId,
      sessions: records
        .filter(
          (record) =>
            !record.archived &&
            record.state &&
            (!workspaceIdentity || record.root_directory === path),
        )
        .flatMap((record) => {
          const snapshot = record.state!.snapshots.find(
            (item) => item.sessionId === record.id,
          );
          if (!snapshot) return [];
          return [
            {
              sessionId: record.id,
              workspaceId: workspaceIdentity ?? path,
              title: snapshot.meta.title,
              titleSource: snapshot.meta.titleSource,
              phase: snapshot.control.phase,
              sessionEnded: snapshot.control.sessionEnded,
              hasBackgroundWork: snapshot.backgroundWorks.some(
                (work) => work.status === "running",
              ),
              lastActivityAt: Date.parse(record.updated_at),
              createdAt: Date.parse(record.created_at),
            },
          ];
        }),
    });
  }
}

export function createCodeUiService(deps: CodeUiServiceDeps) {
  return new CodeUiService(deps);
}
