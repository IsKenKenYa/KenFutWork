import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type CanvasDocumentUpdatedMessage,
  type CodeExecutionScope,
  type CodeGoalControl,
  type CodeUiEvent,
  type CodeUiWorkspace,
  canvasDocumentUpdatedMessageSchema,
  codeGoalControlSchema,
  codeUiControllerTaskListQuerySchema,
  zcodeUiProtocol as protocol,
  type RunCreateRequest,
  resolveContextWindow,
  type StreamEvent,
} from "@kenfutwork/shared";
import {
  appSettingsSchema,
  resolveExecutionState,
  zcodeSessionSubagentsParamsSchema,
  zcodeWorkspacePresentationSchema,
} from "@zcode/shared";
import { z } from "zod";
import type { AgentRunService } from "../../agent/runtime.js";
import { DEFAULT_SANDBOX_ROOT } from "../../agent/sandbox-dir.js";
import type { ServerEnv } from "../../config/env.js";
import type {
  PromptExecutionContext,
  ToolContributionSnapshot,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import type { AgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import type { BlobStore } from "../blob/types.js";
import type { ThreadService } from "../chat/thread-service.js";
import type { CheckpointService } from "../checkpoints/checkpoint-service.js";
import type { CodeGitService } from "../code-git/code-git-service.js";
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
import type { GoalToolEvidenceValidatorResolver } from "../goals/consumer.js";
import { createGoalService, type GoalService } from "../goals/service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ModelCatalogService } from "../model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import {
  type CodeUiProviderSettingsRpc,
  createCodeUiProviderSettingsRpc,
} from "../model-providers/provider-settings-rpc.js";
import type {
  ApprovalEvent,
  ApprovalHostContext,
} from "../permissions/approval-types.js";
import type { PermissionService } from "../permissions/permission-service.js";
import type { PluginRegistryService } from "../plugins/plugin-registry-service.js";
import type { ProcessSandbox } from "../process-sandbox/types.js";
import type { ProjectService } from "../projects/project-service.js";
import { resolveProjectWorkDirectory } from "../projects/work-dir.js";
import type { SettingsService } from "../settings/settings-service.js";
import type {
  TaskWorkContext,
  TaskWorkManager,
  TaskWorkRecord,
} from "../task-work/types.js";
import { readCodeApprovalContext } from "./approval-context.js";
import { createCodeApprovedPlanReader } from "./approved-plan-reader.js";
import { createCodeApprovedPlanStore } from "./approved-plan-store.js";
import { createCodeAttachmentHost } from "./attachments/host.js";
import type { TrustedCodeInput } from "./attachments/input-types.js";
import { codeAttachmentsRpc, isCodeAttachmentRpc } from "./attachments/rpc.js";
import type {
  CodeAttachmentRepository,
  CodeAttachmentsService,
} from "./attachments/types.js";
import { CodeAttachmentError } from "./attachments/types.js";
import { createCodeUiBackgroundOutputView } from "./background-output-view.js";
import { CodeUiConnections } from "./connections.js";
import { createCodeUiWindowController } from "./controller-host.js";
import {
  type CodeUiConversationState,
  createCodeUiConversation,
} from "./conversation.js";
import {
  collectTurnFileChanges,
  requireFileChangesTarget,
} from "./file-changes.js";
import { createCodeUiFileHistory } from "./file-history.js";
import { CodeUiFileIndex, codeUiViewerRpc } from "./files.js";
import { claimGoalContinuation } from "./goal-admission.js";
import { createTaskGoalHost, pauseTaskGoal, syncGoal } from "./goals.js";
import { createCodeGuideInputs } from "./guide-input.js";
import { createCodeUiHistoryEdit } from "./history-edit.js";
import { createCodeUiHistoryFork } from "./history-fork.js";
import { createCodeUiFileWatchers } from "./host-file-watcher.js";
import {
  type CodeUiHostGitRpc,
  createCodeUiHostGitRpc,
} from "./host-git-rpc.js";
import {
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
} from "./host-rpc-handler.js";
import type { CodeUiHostTargetRequest } from "./host-service-rpc.js";
import type { CodeAdmittedInput } from "./input-intents.js";
import {
  prepareCodeInputExecution,
  prepareCodeInputRecord,
} from "./input-preparation.js";
import { compileCodeUiModelExecution } from "./model-execution-options.js";
import { createCodeUiOutputHistory } from "./output-history.js";
import {
  createCodeUiOwnedHistory,
  requireHistoryFileChanges,
  requireStoredFileChanges,
} from "./owned-history.js";
import { createCodePlanningControl } from "./planning-control.js";
import { createCodeUiPluginsHost } from "./plugins.js";
import type { CodeInputSettlement } from "./queue-control.js";
import {
  applyCodeQueueCommand,
  CODE_QUEUE_COMMANDS,
  codeInputRouting,
} from "./queue-control.js";
import {
  type CodeUiRepository,
  CodeUiRepositoryError,
  type CodeUiSessionRecord,
  codeUiTaskControlRejection,
} from "./repository.js";
import { listCodeSessionSubagents } from "./subagent-directory.js";
import { codeUiTaskMeta } from "./task-index.js";
import type {
  CodeUserInputService,
  UserInputEvent,
  UserInputResolutionResult,
} from "./user-input-types.js";
import {
  type ConversationWorkContextProvider,
  contributionsForRun,
  freezeWorkContext,
  latestWorkContext,
  workContextForRun,
  workContextProviderPreset,
} from "./work-context.js";
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
  captureContributions?: (
    preset: "code" | "design",
  ) => ToolContributionSnapshot;
  workContextProvider?: (
    preset: "code" | "design",
  ) => ConversationWorkContextProvider | undefined;
  goals?: GoalService;
  goalToolEvidenceValidator?: GoalToolEvidenceValidatorResolver;
  hostRpcHandler?: (
    service: string,
    method: string,
  ) => CodeUiHostRpcHandler | undefined;
  plugins?: PluginRegistryService;
  checkpoints?: CheckpointService;
  permissions?: PermissionService;
  userInputs?: CodeUserInputService;
  terminals?: CodeTerminalService;
  /**
   * Run 终态自动提交（G3/Q8）：code-git 域的收口缝。缺席（测试装配）时终态不提交，
   * 不影响 run 生命周期；开关/跳过/失败静默全部在 code-git 侧收口。
   */
  codeGit?: Pick<CodeGitService, "autoCommitRun">;
  blob?: BlobStore;
  attachmentRepository?: CodeAttachmentRepository;
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

type CodePreparedModel = {
  selection: NonNullable<protocol.SessionConfigState["modelSelection"]>;
  modelInvocation: ModelInvocationSnapshot;
};
const conversationCommandArgsSchema = z.tuple([
  z
    .object({
      workspacePath: z.string().min(1),
      workspaceIdentity: z.string().min(1).optional(),
      projectId: z.uuid().optional(),
      envelope: protocol.commandEnvelopeSchema.strict(),
      goalControl: codeGoalControlSchema.optional(),
    })
    .strict(),
]);

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
        root.active_run_id !== event.identity.runId ||
        owner.config.planEnabled !== true))
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
  goalControl?: CodeGoalControl,
): string {
  return createHash("sha256")
    .update(
      canonical({
        sessionId: envelope.sessionId,
        type: envelope.type,
        payload: envelope.payload,
        ...(envelope.taskControl ? { taskControl: envelope.taskControl } : {}),
        ...(goalControl ? { goalControl } : {}),
      }),
    )
    .digest("hex");
}

/** 服务定义的具体 Provider；原 GUI 仅调用该域提供的 RPC/会话消费接口。 */
export class CodeUiService {
  private readonly goals: GoalService;
  readonly taskGoals: ReturnType<typeof createTaskGoalHost>;
  private readonly stoppingCommands = new Map<string, Promise<unknown>>();
  private readonly guideInputs: ReturnType<typeof createCodeGuideInputs>;
  private readonly planning: ReturnType<typeof createCodePlanningControl>;
  private readonly approvedPlans: ReturnType<
    typeof createCodeApprovedPlanReader
  >;
  readonly userInputs: CodeUserInputService | undefined;
  readonly outputHistory: ReturnType<typeof createCodeUiOutputHistory>;
  private readonly backgroundOutput: ReturnType<
    typeof createCodeUiBackgroundOutputView
  >;
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
  private readonly watchers: ReturnType<typeof createCodeUiFileWatchers>;
  private readonly git: CodeUiHostGitRpc | undefined;
  private closing = false;
  private attachmentsUsed = false;
  private readonly inputOwner: { hostId: string; runtimeId: string };
  private initialization: Promise<void> | undefined;
  private readonly fileIndexes = new WeakMap<object, CodeUiFileIndex>();
  private readonly fileHistory: ReturnType<typeof createCodeUiFileHistory>;
  private readonly historyEdit: ReturnType<typeof createCodeUiHistoryEdit>;
  private readonly historyFork: ReturnType<typeof createCodeUiHistoryFork>;
  private readonly workspaceConfig: ReturnType<
    typeof createCodeUiWorkspaceConfigHost
  >;
  private readonly plugins:
    | ReturnType<typeof createCodeUiPluginsHost>
    | undefined;
  constructor(private readonly deps: CodeUiServiceDeps) {
    this.goals = deps.goals ?? createGoalService();
    this.taskGoals = createTaskGoalHost({
      goals: this.goals,
      repository: deps.repository,
      ...(deps.goalToolEvidenceValidator
        ? { goalToolEvidenceValidator: deps.goalToolEvidenceValidator }
        : {}),
      refresh: (instanceId, path, projectId) =>
        this.refreshTaskProjection(instanceId, path, projectId),
    });
    const files = createCodeApprovedPlanStore();
    this.approvedPlans = createCodeApprovedPlanReader({
      repository: deps.repository,
      localInstance: deps.localInstance,
      settings: deps.settings,
      files,
    });
    this.planning = createCodePlanningControl({
      repository: deps.repository,
      localInstance: deps.localInstance,
      files,
      refresh: (instanceId, path, projectId) =>
        this.refreshTaskProjection(instanceId, path, projectId),
    });
    this.guideInputs = createCodeGuideInputs({
      goals: this.goals,
      repository: deps.repository,
      refresh: (instanceId, path, projectId) =>
        this.refreshTaskProjection(instanceId, path, projectId),
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
    this.outputHistory = createCodeUiOutputHistory({
      repository: deps.repository,
      taskWork: deps.taskWork,
      settings: deps.settings,
      localInstance: deps.localInstance,
      ...(deps.blob ? { blob: deps.blob } : {}),
      executionOutputRoot: join(
        dirname(resolve(deps.env.checkpointRoot ?? "data/checkpoints")),
        "execution-output",
      ),
    });
    this.backgroundOutput = createCodeUiBackgroundOutputView({
      load: (actor, sessionId) => this.loadConversation(actor, sessionId),
      outputs: this.outputHistory,
      settings: deps.settings,
    });
    this.historyFork = createCodeUiHistoryFork({
      goals: this.goals,
      owner: this.inputOwner,
      blob: deps.blob,
      repository: deps.repository,
      outputs: () => this.outputHistory,
      attachments: () => {
        if (this.attachments) this.attachmentsUsed = true;
        return this.attachments;
      },
      settings: deps.settings,
      agentRuns: deps.agentRuns,
      agentRunMetadata: deps.agentRunMetadata,
      threads: deps.threads,
      localInstance: deps.localInstance,
      load: (actor, sessionId) => this.loadConversation(actor, sessionId),
      refresh: (instanceId, path, projectId) =>
        this.refreshTaskProjection(instanceId, path, projectId),
      fingerprint: codeUiCommandFingerprint,
    });
    this.historyEdit = createCodeUiHistoryEdit({
      goals: this.goals,
      ...(deps.captureContributions
        ? { captureContributions: deps.captureContributions }
        : {}),
      repository: deps.repository,
      settings: deps.settings,
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
      fingerprint: (envelope) => codeUiCommandFingerprint(envelope),
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
      await this.historyFork.recover();
      await this.deps.repository.recoverRuntimeInputs(this.inputOwner);
    })();
    return this.initialization;
  }

  async admitExternalRun(
    actor: LocalActor,
    scopeHandle: ExecutionScopeHandle,
    inputCommandId: string,
    text: string,
    request?: RunCreateRequest,
  ) {
    const scope = scopeHandle.describe();
    const taskControl = {
      projectId: scope.projectId,
      branchGeneration: scopeHandle.branchGeneration,
    };
    const loaded = await this.loadConversation(actor, scope.taskId);
    if (request?.attachments?.length || request?.mentions?.length)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "请通过会话附件或资源引用发送素材，旧素材参数已停用。",
      );
    if (
      (request?.taskId && request.taskId !== scope.taskId) ||
      (request?.projectId && request.projectId !== scope.projectId) ||
      (request?.scopeGeneration !== undefined &&
        request.scopeGeneration !== scope.generation) ||
      (request?.branchGeneration !== undefined &&
        request.branchGeneration !== scopeHandle.branchGeneration)
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "任务、项目或授权版本已改变，请重新提交。",
      );
    const workContext = request?.workContext ?? {
      preset: request?.preset ?? "code",
      ...(request?.canvasId ? { canvasId: request.canvasId } : {}),
      ...(request?.imageGenerationPreference
        ? { imageGenerationPreference: request.imageGenerationPreference }
        : {}),
      ...(request?.videoGenerationPreference
        ? { videoGenerationPreference: request.videoGenerationPreference }
        : {}),
    };
    if (
      (request?.preset && request.preset !== workContext.preset) ||
      (request?.canvasId && request.canvasId !== workContext.canvasId)
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "资源引用与工作方式不一致，请重新提交。",
      );
    let modelSelection: protocol.SessionConfigState["modelSelection"];
    if (request?.model) {
      const separator = request.model.indexOf(":");
      if (separator < 1 || separator === request.model.length - 1)
        throw new CodeUiRepositoryError(
          "command_conflict",
          "请使用供应商与模型的完整标识，或在会话中选择模型。",
        );
      const providerId = request.model.slice(0, separator);
      const modelId = request.model.slice(separator + 1);
      modelSelection = { providerId, modelId };
    }
    const envelope: protocol.CommandEnvelope = {
      clientId: actor.accessClientId ?? "host.agent-runs",
      commandId: inputCommandId,
      sessionId: scope.taskId,
      taskControl,
      type: "sendText",
      payload: {
        text,
        workContext,
        ...(modelSelection ? { modelSelection } : {}),
      },
      issuedAt: Date.now(),
    };
    const admitted = await this.admitText(actor, loaded.project.path, envelope);
    if (!["accepted", "duplicate"].includes(admitted.result.status))
      throw new CodeUiRepositoryError(
        "command_conflict",
        admitted.result.message ?? "输入未被接纳，请查看会话状态。",
      );
    const persisted = await this.deps.repository.find(
      scope.instanceId,
      scope.taskId,
    );
    const input = persisted?.state?.inputs?.find(
      (entry) =>
        entry.intent.clientId === envelope.clientId &&
        entry.intent.sourceCommandId === inputCommandId,
    );
    if (!input)
      throw new CodeUiRepositoryError(
        "not_found",
        "已接纳输入的运行身份不存在，请重新连接。",
      );
    return {
      runId: input.runId,
      sessionId: scope.taskId,
      conversationId: request?.conversationId ?? scope.taskId,
      status: "accepted" as const,
      publish: admitted.publish,
    };
  }

  async cancelExternalRun(actor: LocalActor, runId: string, taskId?: string) {
    const instance = await this.deps.localInstance.resolve(actor);
    const root = await this.deps.repository.findRunOwner(
      instance.instanceId,
      runId,
    );
    if (!root?.state || (taskId && taskId !== root.id))
      throw new CodeUiRepositoryError(
        "not_found",
        "运行不属于当前任务或已经删除。",
      );
    const queued = root.state.inputs?.find(
      (entry) =>
        entry.runId === runId &&
        entry.status === "queued" &&
        entry.intent.delivery.admitted !== "guide",
    );
    const owner = root.state.snapshots.find(
      (snapshot) =>
        snapshot.control.phase === "running" &&
        snapshot.control.activeWorks.some(
          (work) => work.foregroundExecutionId === runId,
        ),
    );
    if (!queued && !owner)
      throw new CodeUiRepositoryError(
        "not_found",
        "运行已结束，请查看会话结果。",
      );
    const snapshot = root.state.snapshots.find(
      (entry) => entry.sessionId === root.id,
    )!;
    const envelope: protocol.CommandEnvelope = {
      clientId: actor.accessClientId ?? "host.agent-runs",
      commandId: `cancel:${runId}`,
      sessionId: queued ? root.id : owner!.sessionId,
      taskControl: {
        projectId: root.project_id,
        branchGeneration: Number(root.branch_generation),
      },
      type: queued ? "deleteQueueItem" : "stop",
      payload: queued
        ? { queueItemId: queued.intent.queueItemId }
        : { expectedForegroundExecutionId: runId },
      baseRevision: snapshot.revision,
      baseLogEpoch: snapshot.logEpoch,
      issuedAt: Date.now(),
    };
    const result = queued
      ? await this.queueCommand(actor, root.root_directory!, envelope)
      : await this.stopExecution(actor, envelope);
    if (!["accepted", "duplicate"].includes(result.result.status))
      throw new CodeUiRepositoryError(
        "command_conflict",
        result.result.message ?? "运行状态已改变，请重新查看会话。",
      );
    const publish =
      "publish" in result
        ? result.publish
        : "afterSend" in result
          ? result.afterSend
          : undefined;
    if (typeof publish === "function") await publish();
    return { runId, status: "canceled" as const };
  }

  async onApprovalEvent(event: ApprovalEvent): Promise<void> {
    return this.onBoundInteractionEvent(event);
  }

  async readApprovalContext(
    context: ToolExecutionContext,
  ): Promise<ApprovalHostContext | null> {
    return readCodeApprovalContext(this.deps.repository, context);
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
          goals: this.goals,
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
          workContext: request.workContext,
          frozenContributions: request.frozenContributions,
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
          goals: this.goals,
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
              goals: this.goals,
              sessionId: root.id,
              workspacePath: root.root_directory!,
              config: snapshot.config,
              state: root.state!,
            });
            host.recordChildRunEvent(
              request.childSessionId,
              event,
              request.workContext,
              request.frozenContributions,
            );
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
        goals: this.goals,
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
          goals: this.goals,
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
    const taskControl = {
      projectId: loaded.root.project_id,
      branchGeneration: Number(loaded.root.branch_generation),
    };
    const scopeHandle = await this.deps.executionScopes.openTask(actor, taskId);
    const context: TaskWorkContext = {
      actor,
      scope: scopeHandle.describe(),
      agentId: scopeHandle.agentId,
      runId: "continuation-admission",
      branchGeneration: taskControl.branchGeneration,
    };
    const pending = (await this.deps.taskWork.list(context)).filter(
      (record) =>
        record.branchGeneration === context.branchGeneration &&
        record.status !== "running" &&
        !record.consumed,
    );
    if (pending.length === 0) return false;
    const snapshot = loaded.host.getSnapshot();
    const goal = loaded.root.state?.goalRecord;
    if (goal && !["active", "notSatisfied", "complete"].includes(goal.status))
      return false;
    if (
      goal &&
      goal.status !== "complete" &&
      (snapshot.queue.items.length ||
        snapshot.pendingInteractions.length ||
        loaded.root.state?.inputs?.some((input) => input.status === "queued"))
    )
      return false;
    let prepared: CodePreparedModel;
    try {
      prepared =
        goal && goal.status !== "complete"
          ? await this.prepareGoalModel(actor, loaded.root.state!)
          : await this.prepareInputModel(actor, snapshot.config.modelSelection);
    } catch (error) {
      if (!goal || goal.status === "complete") throw error;
      await this.pauseGoalForModel(actor, loaded.root, goal, error);
      return false;
    }
    const { selection, modelInvocation } = prepared;
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
      taskControl,
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
          Number(root.branch_generation) !== context.branchGeneration ||
          root.state?.goalRecord?.goalId !== goal?.goalId ||
          root.state?.goalRecord?.revision !== goal?.revision
        )
          throw new CodeUiRepositoryError(
            "command_conflict",
            "Task 已忙碌或分支改变，后台结果留待下一模型边界",
          );
        const current = root.state!.snapshots.find(
          (entry) => entry.sessionId === root.id,
        )!;
        const host = createCodeUiConversation({
          goals: this.goals,
          sessionId: root.id,
          workspacePath: root.root_directory!,
          config: current.config,
          state: root.state!,
        });
        const continuationWorkContext =
          goal && goal.status !== "complete"
            ? freezeWorkContext(root.state?.goalModel?.workContext)
            : latestWorkContext(root.state!);
        host.startTurn({
          runId,
          commandId,
          text,
          origin: "backgroundResult",
          modelSelection: selection,
          workContext: continuationWorkContext,
          frozenContributions: this.deps.captureContributions?.(
            continuationWorkContext.preset,
          ),
        });
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
    if (ack.status !== "accepted") return false;
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

  async notifyCanvasDocumentUpdated(
    instanceId: string,
    message: CanvasDocumentUpdatedMessage,
  ): Promise<void> {
    await this.connections.notifyEvent(instanceId, {
      event: "canvasDocumentUpdated",
      data: canvasDocumentUpdatedMessageSchema.parse(message),
    });
  }

  async openConnection(
    user: LocalActor,
    send: (event: CodeUiEvent) => Promise<void>,
    close: () => void,
  ) {
    this.assertConnectionHostOpen();
    await this.initialize();
    const workspace = await this.deps.localInstance.resolve(user);
    const settings = await this.deps.settings.getInstanceSettings(
      user,
      workspace.instanceId,
    );
    this.assertConnectionHostOpen();
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
        await this.closeResources([
          connection.dispose(),
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
    await this.closeResources([
      this.connections.closeAll(),
      ...[...this.controllers.values()].map((controller) =>
        controller.host.dispose(),
      ),
      this.deps.terminals?.close("Code通知宿主关闭"),
      this.attachments?.close(),
      this.watchers.close(),
    ]);
    this.controllers.clear();
  }

  private assertConnectionHostOpen() {
    if (this.closing)
      throw new CodeUiRepositoryError("not_found", "Code通知宿主已关闭。");
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

  async refreshMovedTask(
    actor: LocalActor,
    event: {
      instanceId: string;
      taskId: string;
      sourceProjectId: string;
      targetProjectId: string;
      workspacePath: string;
      sessionIds: readonly string[];
    },
  ): Promise<void> {
    if (actor.instanceId !== event.instanceId)
      throw new CodeUiRepositoryError("not_found", "移动结果不属于当前实例。");
    this.connections.retireTaskSubscriptions(
      event.instanceId,
      event.sessionIds,
      event.sourceProjectId,
    );
    this.taskActors.delete(JSON.stringify([event.instanceId, event.taskId]));
    const notifications = await Promise.allSettled([
      ...[...this.controllers.values()]
        .filter((controller) => controller.instanceId === event.instanceId)
        .map((controller) => controller.host.refresh()),
      this.connections.refresh(
        event.instanceId,
        event.workspacePath,
        event.sourceProjectId,
      ),
      this.connections.refresh(
        event.instanceId,
        event.workspacePath,
        event.targetProjectId,
      ),
      this.connections.notifyEvent(event.instanceId, {
        event: "service",
        service: "broadcast",
        name: "onMessage",
        data: { channel: "state:projects", payload: {} },
      }),
    ]);
    const failures = notifications.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      const error = new CodeUiHostRpcError(
        "project.task-moved-refresh-required",
        "项目已移动，请刷新列表。",
        503,
      );
      error.cause = new AggregateError(failures, "任务已移动，项目通知失败。");
      throw error;
    }
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
      if (reason === "delete") {
        await this.attachments?.purgeTask(user, root.id, generation);
        await this.outputHistory.purge(user, root, generation);
      }
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
    this.assertConnectionHostOpen();
    const contributed = this.deps.hostRpcHandler?.(service, method);
    // 空字符串是客户端「尚未绑定连接」的载具口径，与未传等价；
    // 否则重连窗口的 connection-less 读取会被所有权守卫误报成连接丢失。
    const bound = connectionId ? connectionId : undefined;
    if (bound !== undefined || contributed) {
      const owner = await this.deps.localInstance.resolve(user);
      if (contributed) {
        const context = this.connections.context(
          owner.instanceId,
          bound,
          user.accessClientId,
        );
        return { result: await contributed.call(context.actor, args, context) };
      }
      this.connections.require(
        owner.instanceId,
        bound,
        false,
        user.accessClientId,
      );
    }
    if (service === "zcode-session" && method === "setGoalBudget") {
      const value = args[0];
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("目标预算参数无效");
      const input = value as Record<string, unknown>;
      if (
        typeof input.taskId !== "string" ||
        typeof input.commandId !== "string" ||
        typeof input.revision !== "number" ||
        !(input.tokenBudget === null || typeof input.tokenBudget === "number")
      )
        throw new Error("目标预算参数无效");
      const loaded = await this.loadConversation(user, input.taskId);
      if (loaded.entry.parent_session_id)
        throw new Error("目标预算只能设置当前根Task");
      const envelope: protocol.CommandEnvelope = {
        clientId: `host.budget:${user.accessClientId ?? "script"}`,
        commandId: input.commandId,
        sessionId: input.taskId,
        taskControl: {
          projectId: loaded.root.project_id,
          branchGeneration: Number(loaded.root.branch_generation),
        },
        type: "sendText",
        payload: { revision: input.revision, tokenBudget: input.tokenBudget },
        issuedAt: Date.now(),
      };
      const ack = await this.deps.repository.applyCommand(
        loaded.instanceId,
        envelope,
        codeUiCommandFingerprint(envelope),
        (root) => {
          const state = structuredClone(root.state!);
          if (
            !state.goalRecord ||
            root.archived ||
            root.execution_state !== "ready"
          )
            throw new Error("当前Task没有有效目标");
          state.goalRecord = this.goals.setBudget(state.goalRecord, {
            goalId: state.goalRecord.goalId,
            revision: input.revision as number,
            tokenBudget: input.tokenBudget as number | null,
          });
          syncGoal(state, root.id);
          const snapshot = state.snapshots.find(
            (item) => item.sessionId === root.id,
          )!;
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
      const current = await this.deps.repository.find(
        loaded.instanceId,
        input.taskId,
      );
      if (
        ack.status === "accepted" &&
        current?.state?.goalRecord?.reason === "budget.stop" &&
        current.active_run_id
      )
        this.deps.agentRuns.cancelRun(current.active_run_id);
      return {
        result: ack,
        publish: () =>
          this.refreshTaskProjection(
            loaded.instanceId,
            loaded.project.path,
            loaded.project.projectId,
          ),
      };
    }
    if (service === "window-controller") {
      const owner = await this.deps.localInstance.resolve(user);
      const connection = this.connections.require(
        owner.instanceId,
        bound,
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
        bound,
        false,
        user.accessClientId,
      );
      return this.plugins.call(user, method, args[0]);
    }
    if (service === "file-watcher" || service === "git") {
      const owner = await this.deps.localInstance.resolve(user);
      const current = this.connections.require(owner.instanceId, bound, false);
      if (current.hello.auth.userId !== user.instanceId)
        throw new CodeUiRepositoryError(
          "not_found",
          "宿主连接不属于当前用户。",
        );
      const connection = {
        connectionId: bound!,
        instanceId: owner.instanceId,
      };
      return service === "file-watcher"
        ? this.watchers.call(user, method, args, connection)
        : (this.git?.call(user, method, args, connection) ?? null);
    }
    if (
      service === "providerSettingsService" ||
      service === "modelSelectionService"
    ) {
      // 实例作用域读写不依赖通知连接；仅在携带绑定时校验连接所有权。
      if (bound !== undefined) {
        const owner = await this.deps.localInstance.resolve(user);
        this.connections.require(owner.instanceId, bound, false);
      }
      return this.providerSettings.call(user, service, method, args);
    }
    if (service === "terminal" && this.deps.terminals) {
      const owner = await this.deps.localInstance.resolve(user);
      this.connections.require(owner.instanceId, bound, false);
      const preferences = appSettingsSchema.parse(
        await this.deps.repository.readHumanPreferences(owner.instanceId),
      );
      return codeUiTerminalRpc({
        terminals: this.deps.terminals,
        actor: user,
        connectionId: bound!,
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
            this.connections.send(owner.instanceId, bound!, {
              event: "service",
              service: "terminal",
              name: "onDynamicData",
              terminalId,
              data,
            }),
          exit: (exit) =>
            this.connections.send(owner.instanceId, bound!, {
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
        bound,
        false,
      );
      const human = await this.humanWorkspace.call(user, service, method, args);
      if (human) return human;
      if (service === "file") {
        const outputFile = await this.backgroundOutput.file(
          user,
          method,
          args[0],
        );
        if (outputFile) return outputFile;
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
      "deleteTask",
    ]);
    if (!supported.has(method)) return null;
    const workspace = await this.deps.localInstance.resolve(user);
    const projects = await this.listWorkspaces(user);
    const target = args[0] as {
      workspacePath: string;
      taskId?: string;
      projectId?: string;
      workspaceIdentity?: string;
    };
    if (method === "deleteTask") {
      if (!target?.taskId)
        throw new CodeUiRepositoryError("not_found", "删除缺少根Task身份。");
      const loaded = await this.loadConversation(user, target.taskId);
      if (
        loaded.entry.parent_session_id ||
        loaded.project.path !== target.workspacePath ||
        (target.projectId && target.projectId !== loaded.project.projectId) ||
        (target.workspaceIdentity &&
          target.workspaceIdentity !==
            JSON.stringify([loaded.project.projectId, loaded.project.path]))
      )
        throw new CodeUiRepositoryError(
          "not_found",
          "删除目标不属于该Project与根Task固定目录。",
        );
      await this.deleteTask(user, loaded.root.id);
      return { result: null };
    }
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
        await this.historyFork.decorate(user, loaded, snapshot);
        if (connectionId && sessionId === loaded.root.id) {
          const goal = loaded.root.state?.goalRecord;
          await this.connections.send(workspace.instanceId, connectionId, {
            event: "service",
            service: "zcodeAgentService",
            name: "onGoalControlState",
            data: {
              taskId: sessionId,
              goal: goal
                ? { goalId: goal.goalId, revision: goal.revision }
                : null,
            },
          });
        }
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
    if (method === "backgroundBashOutputV4")
      return this.backgroundOutput.query(user, args[0]);
    if (method === "listSessionSubagents") {
      const value = args[0] as {
        sessionId: string;
        endedLimit?: number;
        endedCursor?: string;
      };
      const parsed = zcodeSessionSubagentsParamsSchema.parse({
        sessionId: value.sessionId,
        ...(value.endedLimit !== undefined
          ? { endedLimit: value.endedLimit }
          : {}),
        ...(value.endedCursor !== undefined
          ? { endedCursor: value.endedCursor }
          : {}),
      });
      const loaded = await this.loadConversation(user, parsed.sessionId);
      if (
        target.workspacePath !== loaded.project.path ||
        (target.projectId && target.projectId !== loaded.project.projectId) ||
        (target.workspaceIdentity &&
          target.workspaceIdentity !==
            JSON.stringify([loaded.project.projectId, loaded.project.path]))
      )
        throw new CodeUiRepositoryError(
          "not_found",
          "子会话目录不属于当前Task固定工作目录。",
        );
      return {
        result: listCodeSessionSubagents(
          loaded.host.getSnapshot(parsed.sessionId),
          loaded.root.state?.snapshots ?? [],
          parsed,
        ),
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
      const childDetails = loaded.root.state?.inheritedSessions?.find(
        (session) => session.owner.sessionId === parsed.sessionId,
      );
      if (childDetails) {
        if (
          childDetails.owner.instanceId !== loaded.instanceId ||
          childDetails.owner.projectId !== loaded.root.project_id ||
          childDetails.owner.taskId !== loaded.root.id
        )
          throw new CodeUiRepositoryError(
            "not_found",
            "子历史详情不属于当前Task。",
          );
        const stored = requireStoredFileChanges(
          childDetails.fileChanges.find((file) => file.turnId === header.turnId)
            ?.details,
          {
            maxEvents: limits.codeSearchMaxResults,
            maxBytes: limits.codePatchMaxBytes,
          },
        );
        if (stored) return { result: stored };
      }
      const owned = loaded.root.state?.inheritedHistory?.some(
        (turn) => turn.owner.turnId === header.turnId,
      )
        ? await createCodeUiOwnedHistory(this.deps).resolve(
            user,
            loaded.root,
            header.turnId,
          )
        : null;
      const inherited =
        owned &&
        requireHistoryFileChanges(owned, {
          maxEvents: limits.codeSearchMaxResults,
          maxBytes: limits.codePatchMaxBytes,
        });
      if (inherited) return { result: inherited };
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
      const [input] = conversationCommandArgsSchema.parse(args);
      const revokeSchema =
        protocol.commandPayloadSchemas.revokeWorkspaceHookTrust;
      const payloadSchema =
        input.envelope.type === "revokeWorkspaceHookTrust"
          ? z.union([
              revokeSchema.options[0].strict(),
              revokeSchema.options[1].strict(),
            ])
          : protocol.commandPayloadSchemas[input.envelope.type].strict();
      const payload = payloadSchema.parse(input.envelope.payload);
      const parsed = protocol.parseCommandEnvelope({
        ...input.envelope,
        payload,
      });
      if (!parsed.ok) throw parsed.error;
      const goalControl = input.goalControl;
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
        return this.prepareSessionCreation(user, parsed.envelope);
      if (parsed.envelope.sessionId) {
        const historical = await this.loadConversation(
          user,
          parsed.envelope.sessionId,
        );
        if (
          historical.root.state?.inheritedSessions?.some(
            (session) => session.owner.sessionId === historical.entry.id,
          )
        )
          return {
            result: protocol.commandAckSchema.parse({
              commandId: parsed.envelope.commandId,
              status: "rejected",
              reasonCode: "guard.historicalSessionReadOnly",
              message:
                "此子会话是分叉截点的只读历史，不继承运行、审批或文件恢复权限。",
              revisionAtDecision: historical.host.getSnapshot(
                historical.entry.id,
              ).revision,
            }),
          };
      }
      if (
        parsed.envelope.type === "sendText" ||
        parsed.envelope.type === "sendGoalCommand" ||
        parsed.envelope.type === "compact"
      )
        return this.sendText(
          user,
          input.workspacePath,
          parsed.envelope,
          goalControl,
        );
      if (
        parsed.envelope.type === "editUserQuery" ||
        parsed.envelope.type === "retryTurn"
      )
        return this.historyEdit.command(user, target, parsed.envelope);
      if (parsed.envelope.type === "forkAssistant")
        return this.historyFork.command(user, target, parsed.envelope);
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
      if (
        parsed.envelope.type === "pauseGoal" ||
        parsed.envelope.type === "resumeGoal"
      )
        return this.goalCommand(
          user,
          input.workspacePath,
          parsed.envelope,
          goalControl,
        );
      if (parsed.envelope.type === "stop")
        return this.stopExecution(user, parsed.envelope);
      if (parsed.envelope.type === "cancelBackgroundWork")
        return this.cancelBackgroundWork(user, parsed.envelope);
    }
    return null;
  }

  private async goalCommand(
    user: LocalActor,
    workspacePath: string,
    envelope: protocol.CommandEnvelope,
    goalControl?: CodeGoalControl,
  ) {
    if (!envelope.sessionId) throw new Error("目标缺少Task身份");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    if (loaded.entry.parent_session_id || loaded.project.path !== workspacePath)
      throw new Error("目标不属于当前Task");
    const replay = await this.verifiedInputReplay(
      loaded.instanceId,
      envelope,
      goalControl,
    );
    if (replay) return { result: replay, publish: publishOnce(async () => {}) };
    try {
      return await this.prepareGoalCommand(
        user,
        workspacePath,
        envelope,
        loaded,
        goalControl,
      );
    } catch (error) {
      const raced = await this.verifiedInputReplay(
        loaded.instanceId,
        envelope,
        goalControl,
      );
      if (raced) return { result: raced, publish: publishOnce(async () => {}) };
      throw error;
    }
  }

  private async prepareGoalCommand(
    user: LocalActor,
    workspacePath: string,
    envelope: protocol.CommandEnvelope,
    loaded: Awaited<ReturnType<CodeUiService["loadConversation"]>>,
    goalControl?: CodeGoalControl,
  ) {
    const goals = this.goals;
    const resumedModel =
      envelope.type === "resumeGoal"
        ? goalControl?.resumeModelSelection
          ? {
              selection: goalControl.resumeModelSelection,
              modelInvocation: await this.prepareModelInvocation(
                user,
                goalControl.resumeModelSelection,
              ),
            }
          : await this.prepareGoalModel(user, loaded.root.state!)
        : undefined;
    const ack = await this.deps.repository.applyCommand(
      loaded.instanceId,
      envelope,
      codeUiCommandFingerprint(envelope, goalControl),
      (root) => {
        const state = structuredClone(root.state!);
        const goal = state.goalRecord;
        if (goalControl) this.requireGoalFence(goal, goalControl);
        if (!goal || root.archived || root.execution_state !== "ready")
          throw new Error("当前Task没有可控制目标");
        state.goalRecord =
          envelope.type === "pauseGoal"
            ? goals.pause(goal, {
                goalId: goal.goalId,
                revision: goal.revision,
                reason: "user.pause",
                at: Date.now(),
              })
            : goals.resume(goal, {
                goalId: goal.goalId,
                revision: goal.revision,
                branchGeneration: Number(root.branch_generation),
              });
        if (resumedModel) {
          state.goalModel = {
            goalId: goal.goalId,
            selection: resumedModel.selection,
            invocation: resumedModel.modelInvocation,
            workContext: freezeWorkContext(state.goalModel?.workContext),
          };
        }
        syncGoal(state, root.id);
        const snapshot = state.snapshots.find(
          (item) => item.sessionId === root.id,
        )!;
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
        if (
          ack.status === "accepted" &&
          envelope.type === "pauseGoal" &&
          loaded.root.active_run_id
        )
          await this.deps.agentRuns.cancelRunAndWait(loaded.root.active_run_id);
        await this.refreshTaskProjection(
          loaded.instanceId,
          workspacePath,
          loaded.project.projectId,
        );
        if (ack.status === "accepted" && envelope.type === "resumeGoal")
          await this.resumeGoal(user, loaded.root.id);
      }),
    };
  }

  private async resumeGoal(user: LocalActor, taskId: string): Promise<void> {
    if (this.closing) return;
    const loaded = await this.loadConversation(user, taskId);
    const goal = loaded.root.state?.goalRecord;
    if (
      !goal ||
      !["active", "notSatisfied"].includes(goal.status) ||
      goal.claimedRunId
    )
      return;
    const snapshot = loaded.host.getSnapshot();
    if (
      snapshot.config.planEnabled ||
      loaded.root.active_run_id ||
      snapshot.queue.items.length ||
      snapshot.pendingInteractions.length ||
      loaded.root.state?.inputs?.some(
        (input) => input.status === "reserved" || input.status === "queued",
      )
    )
      return;
    let prepared: CodePreparedModel;
    try {
      prepared = await this.prepareGoalModel(user, loaded.root.state!);
    } catch (error) {
      await this.pauseGoalForModel(user, loaded.root, goal, error);
      return;
    }
    const { selection, modelInvocation } = prepared;
    const thread = await this.deps.threads.resolveOwnedSessionThread(
      user,
      taskId,
    );
    const runId = randomUUID();
    const text = `继续推进当前目标：${goal.objective}。检查实际结果；未通过验收时继续工作，有真实证据后调用 VerifyGoal。`;
    const commandId = `goal:${goal.goalId}:${goal.revision}:${goal.iteration}`;
    const envelope: protocol.CommandEnvelope = {
      clientId: "host.goal",
      commandId,
      sessionId: taskId,
      taskControl: {
        projectId: loaded.root.project_id,
        branchGeneration: Number(loaded.root.branch_generation),
      },
      type: "sendText",
      payload: { text },
      issuedAt: Date.now(),
    };
    const ack = await this.deps.repository.applyCommand(
      loaded.instanceId,
      envelope,
      codeUiCommandFingerprint(envelope),
      (root) => {
        return claimGoalContinuation(
          root,
          {
            goalId: goal.goalId,
            revision: goal.revision,
            runId,
            commandId,
            text,
            owner: this.inputOwner,
            at: Date.now(),
            modelSelection: selection,
            ...(this.deps.captureContributions
              ? {
                  frozenContributions: this.deps.captureContributions(
                    freezeWorkContext(root.state?.goalModel?.workContext)
                      .preset,
                  ),
                }
              : {}),
          },
          this.goals,
        );
      },
    );
    if (ack.status !== "accepted") return;
    await this.refreshTaskProjection(
      loaded.instanceId,
      loaded.project.path,
      loaded.project.projectId,
    );
    void this.runTurn(
      user,
      loaded.project,
      taskId,
      thread.threadId,
      runId,
      text,
      `${selection.providerId}:${selection.modelId}`,
      modelInvocation,
      undefined,
      { clientId: envelope.clientId, sourceCommandId: commandId },
    ).catch((error: unknown) =>
      console.warn("[code-ui] Goal运行失败：", error),
    );
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
            state: null,
            activeRunId: root.active_run_id,
            ack: {
              commandId: envelope.commandId,
              status: "stale",
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
    const ack = await this.deps.repository.applyScopeCommand(
      loaded.instanceId,
      envelope,
      codeUiCommandFingerprint(envelope),
      async () => {
        // 规划别名只收窄应用策略，不撤销或扩大用户已经授权的物理工作域。
        if (mode === "plan") return;
        await this.deps.executionScopes.updateTask(user, loaded.root.id, {
          sandboxMode:
            mode === "yolo" ? "danger-full-access" : "workspace-write",
        });
      },
      (root) => {
        const state = structuredClone(root.state!);
        const snapshot = state.snapshots.find(
          (item) => item.sessionId === root.id,
        );
        if (!snapshot)
          throw new CodeUiRepositoryError("not_found", "Task 根快照不存在");
        const execution = resolveExecutionState(
          { mode },
          resolveExecutionState({
            mode: snapshot.config.mode,
            ...(snapshot.config.planEnabled !== undefined
              ? { planEnabled: snapshot.config.planEnabled }
              : {}),
          }),
        );
        snapshot.config = {
          ...snapshot.config,
          mode: protocol.commandPayloadSchemas.switchCollaborationMode.parse({
            mode: execution.mode,
          }).mode,
          planEnabled: execution.planEnabled,
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
            ...(approval?.identity.planningEpoch !== undefined
              ? {
                  planningEpoch: root.state?.planningEpoch ?? 0,
                  runId: root.active_run_id ?? "",
                }
              : {}),
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
          status:
            resolution?.status === "rejected"
              ? "rejected"
              : resolution?.status === "alreadyResolved"
                ? "noop"
                : "accepted",
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
    const key = JSON.stringify([
      user.instanceId,
      envelope.clientId,
      envelope.commandId,
    ]);
    const previous = this.stoppingCommands.get(key) ?? Promise.resolve();
    const next = previous.then(
      () => this.applyStopExecution(user, envelope),
      () => this.applyStopExecution(user, envelope),
    );
    this.stoppingCommands.set(key, next);
    try {
      return await next;
    } finally {
      if (this.stoppingCommands.get(key) === next)
        this.stoppingCommands.delete(key);
    }
  }

  private async applyStopExecution(
    user: LocalActor,
    envelope: protocol.CommandEnvelope,
  ) {
    if (!envelope.sessionId)
      throw new CodeUiRepositoryError("not_found", "停止缺少会话身份");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    const payload = protocol.commandPayloadSchemas.stop.parse(envelope.payload);
    let targetChanged = false;
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
        ) {
          targetChanged = true;
          return;
        }
        if (!execution) return;
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
                  (work) =>
                    work.kind === "primaryTurn" ||
                    work.kind === "foregroundSubagent",
                )?.foregroundExecutionId ??
                current.active_run_id ??
                state.inputs?.find((entry) => entry.status === "reserved")
                  ?.previousRunId;
              if (
                payload.expectedForegroundExecutionId &&
                payload.expectedForegroundExecutionId !== activeExecution
              )
                return { state, activeRunId: current.active_run_id };
              state.stopRequestedRuns = [
                ...new Set([...(state.stopRequestedRuns ?? []), execution]),
              ];
              // 尚未派发的权限选择与停止同一根锁失效；迟到CAS不能再次签发。
              for (const record of state.inputs ?? [])
                if (record.runId === execution)
                  delete record.pendingScopeSelection;
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
              pauseTaskGoal(
                state,
                current.id,
                "user.stop",
                Date.now(),
                this.goals,
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
                goals: this.goals,
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
        state: null,
        ack: {
          commandId: envelope.commandId,
          status: targetChanged ? "noop" : "accepted",
          ...(targetChanged ? { reasonCode: "guard.stopTargetChanged" } : {}),
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
    goalControl?: CodeGoalControl,
  ) {
    const release = this.deps.localInstance.beginAdmission();
    try {
      return await this.admitText(user, workspacePath, envelope, goalControl);
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
    goalControl?: CodeGoalControl,
  ) {
    if (!envelope.sessionId)
      throw new CodeUiRepositoryError("not_found", "发送命令缺少会话");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    if (loaded.entry.parent_session_id || loaded.project.path !== workspacePath)
      throw new CodeUiRepositoryError(
        "not_found",
        "发送命令不属于根会话工作目录",
      );
    const replay = await this.verifiedInputReplay(
      loaded.instanceId,
      envelope,
      goalControl,
    );
    if (replay) return { result: replay, publish: publishOnce(async () => {}) };
    if (codeUiTaskControlRejection(loaded.root, envelope)) {
      const ack = await this.deps.repository.applyCommand(
        loaded.instanceId,
        envelope,
        codeUiCommandFingerprint(envelope, goalControl),
        () => {
          throw new CodeUiRepositoryError(
            "command_conflict",
            "会话已改变，请重新发送。",
          );
        },
      );
      return { result: ack, publish: publishOnce(async () => {}) };
    }
    try {
      return await this.admitPreparedText(
        user,
        workspacePath,
        envelope,
        loaded,
        goalControl,
      );
    } catch (error) {
      // A concurrent copy may commit while this copy prepares resources. Return
      // its verified receipt instead of treating a deleted reference as rejection.
      const raced = await this.verifiedInputReplay(
        loaded.instanceId,
        envelope,
        goalControl,
      );
      if (raced) return { result: raced, publish: publishOnce(async () => {}) };
      throw error;
    }
  }

  private async verifiedInputReplay(
    instanceId: string,
    envelope: protocol.CommandEnvelope,
    goalControl?: CodeGoalControl,
  ) {
    const queried = await this.deps.repository.queryCommands(
      instanceId,
      envelope.clientId,
      [{ commandId: envelope.commandId, sessionId: envelope.sessionId }],
    );
    const receipt = queried.results[0]?.result;
    if (!receipt || receipt === "unknown") return null;
    return this.deps.repository.applyCommand(
      instanceId,
      envelope,
      codeUiCommandFingerprint(envelope, goalControl),
      () => {
        throw new CodeUiRepositoryError(
          "command_conflict",
          "命令回执已变化，请重新连接后查看状态。",
        );
      },
    );
  }

  private async admitPreparedText(
    user: LocalActor,
    workspacePath: string,
    envelope: protocol.CommandEnvelope,
    loaded: Awaited<ReturnType<CodeUiService["loadConversation"]>>,
    goalControl?: CodeGoalControl,
  ) {
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
    const workContext = await this.prepareWorkContext(
      user,
      loaded.project.projectId,
      compact ? latestWorkContext(loaded.root.state!) : payload.workContext,
      loaded.root.id,
    );
    const frozenContributions = this.deps.captureContributions?.(
      workContext.preset,
    );
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
      codeUiCommandFingerprint(envelope, goalControl),
      (root) => {
        const host = createCodeUiConversation({
          goals: this.goals,
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
        const { execution, requestedSandboxMode } = prepareCodeInputExecution(
          current.config,
          payload,
          compact,
        );
        const requestedGuide =
          !compact &&
          busy &&
          (payload.requestedDelivery === "guide" ||
            (payload.requestedDelivery === undefined &&
              current.config.followupMode === "guide"));
        const guide =
          requestedGuide &&
          !!previous &&
          active?.intent.kind === "sendText" &&
          (!this.deps.captureContributions || !!active.frozenContributions) &&
          active.intent.mode === execution.mode &&
          active.intent.planEnabled === execution.planEnabled &&
          (requestedSandboxMode === undefined ||
            root.sandbox_mode === requestedSandboxMode) &&
          canonical(workContextForRun(root.state!, previous!)) ===
            canonical(workContext) &&
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
        const record = prepareCodeInputRecord({
          command: envelope,
          payload,
          kind: compact ? "compact" : "sendText",
          attachments: codeInputs.map((input) => input.attachment),
          selection,
          execution,
          workContext,
          delivery,
          admissionSeq:
            (root.state?.inputs?.at(-1)?.intent.order.admissionSeq ?? 0) + 1,
          queuePosition: current.queue.items.length,
          runId: guide ? previous! : runId,
          modelInvocation,
          ...(frozenContributions
            ? {
                frozenContributions: guide
                  ? (contributionsForRun(root.state!, previous!) ??
                    frozenContributions)
                  : frozenContributions,
              }
            : {}),
          scopeGeneration: Number(root.scope_generation),
          branchGeneration: Number(root.branch_generation),
          ...(requestedSandboxMode ? { requestedSandboxMode } : {}),
          ...(preempt
            ? {
                preempt: {
                  autoDrain: current.queue.autoDrain,
                  previousRunId: previous!,
                },
              }
            : {}),
        });
        if (envelope.type === "sendGoalCommand") {
          this.requireGoalFence(host.getGoal(), goalControl);
          if (busy || delivery !== "startNow")
            throw new CodeUiRepositoryError(
              "command_conflict",
              "请等待当前运行结束后创建目标",
            );
          const goal = this.goals.create(host.getGoal(), {
            goalId: envelope.commandId,
            objective: payload.text,
            branchGeneration: Number(root.branch_generation),
            at: Date.now(),
          });
          host.setGoal(goal, {
            goalId: goal.goalId,
            selection,
            invocation: modelInvocation,
            workContext,
          });
        }
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
          goals: this.goals,
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
          goals: this.goals,
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
      const goal = (
        await this.deps.repository.find(workspace.instanceId, sessionId)
      )?.state?.goalRecord;
      if (
        event.type === "run.usage" &&
        goal?.reason === "budget.stop" &&
        goal.claimedRunId === event.runId
      )
        this.deps.agentRuns.cancelRun(event.runId);
      if (
        ["run.completed", "run.failed", "run.canceled"].includes(event.type)
      ) {
        await this.notifyTask(user, project, sessionId, "task_status_changed");
        // Run 终态自动提交（G3/Q8）：先于 drainQueuedInput 的下一轮派发（runTurn 的
        // finally 在事件流之后），保证提交的就是本轮变更；autoCommitRun 永不抛，
        // 开关关/非仓库/干净/失败全在 code-git 侧静默收口，不阻塞终态链路。
        if (this.deps.codeGit)
          await this.deps.codeGit.autoCommitRun(user, sessionId);
      }
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

  /**
   * 旧运行缺少冻结容量时使用的模型窗口元数据缓存。
   * 只服务展示层读数：60s TTL 内允许目录变更后短暂滞后（局部常量，不进治理表——
   * 不影响执行路径，仅决定圆环分母多久跟上用户改实例配置）。
   */
  private readonly runUsageModelMetaCache = new Map<
    string,
    { at: number; contextWindowTokens?: number; maxOutputTokens?: number }
  >();
  private static readonly RUN_USAGE_META_TTL_MS = 60_000;

  /** 补齐 run.usage 的 contextWindowTokens/maxOutputTokens（目录声明优先，兜底表次之）。 */
  private async enrichRunUsageWindow(
    event: Extract<StreamEvent, { type: "run.usage" }>,
    user: LocalActor,
    model: string,
  ): Promise<Extract<StreamEvent, { type: "run.usage" }>> {
    if (event.contextWindowTokens !== undefined) return event;
    const now = Date.now();
    const cached = this.runUsageModelMetaCache.get(model);
    let meta =
      cached && now - cached.at < CodeUiService.RUN_USAGE_META_TTL_MS
        ? cached
        : undefined;
    if (!meta) {
      meta = { at: now };
      try {
        const entries = await this.deps.modelCatalog.listCatalog(user);
        // run 的 model 是「实例:模型」specifier（与 validateSpecifier 同口径）；目录里
        // id 是模型名——两种写法都匹配，认不出时留空（界面只给绝对量，不编分母）。
        const entry = entries.find(
          (candidate) =>
            `${candidate.provider.instanceId}:${candidate.id}` === model ||
            candidate.id === model,
        );
        const declared =
          entry?.model.contextWindow ?? entry?.hints?.contextWindow;
        const window = resolveContextWindow(declared, entry?.id ?? model);
        if (window !== null) meta.contextWindowTokens = window;
        const maxOutput = entry?.model.maxOutputTokens;
        if (typeof maxOutput === "number" && maxOutput > 0)
          meta.maxOutputTokens = maxOutput;
      } catch {
        // 目录读取失败：不带窗口字段，客户端按「窗口未知」呈现
      }
      this.runUsageModelMetaCache.set(model, meta);
    }
    return {
      ...event,
      ...(meta.contextWindowTokens !== undefined
        ? { contextWindowTokens: meta.contextWindowTokens }
        : {}),
      ...(meta.maxOutputTokens !== undefined
        ? { maxOutputTokens: meta.maxOutputTokens }
        : {}),
    };
  }

  /** 新输入已占有原Run身份后才更新物理权限；不从历史重试或后台续跑重新签发。 */
  private async applyInputScope(
    user: LocalActor,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    const workspace = await this.deps.localInstance.resolve(user);
    const before = await this.deps.repository.find(
      workspace.instanceId,
      sessionId,
    );
    const input = before?.state?.inputs?.find(
      (record) => record.runId === runId && record.status === "active",
    );
    if (!input?.pendingScopeSelection || input.historyOf) return;
    if (
      !before ||
      before.archived ||
      before.execution_state !== "ready" ||
      before.active_run_id !== runId ||
      input.scopeGeneration !== Number(before.scope_generation) ||
      input.branchGeneration !== Number(before.branch_generation) ||
      before.state?.inputs?.some((record) => record.status === "reserved")
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "这条输入的Task授权或运行已改变，请重新提交。",
      );
    const updated =
      before.sandbox_mode === input.pendingScopeSelection
        ? { generation: Number(before.scope_generation) }
        : await this.deps.executionScopes.updateTask(
            user,
            sessionId,
            { sandboxMode: input.pendingScopeSelection },
            {
              scopeGeneration: input.scopeGeneration,
              branchGeneration: input.branchGeneration,
              runId,
              sourceCommandId: input.intent.sourceCommandId,
            },
          );
    await this.deps.repository.appendEvent(
      workspace.instanceId,
      sessionId,
      {
        key: `input-scope:${runId}/${updated.generation}`,
        fingerprint: `${input.scopeGeneration}/${updated.generation}`,
        event: {
          type: "input.scope_selected",
          runId,
          scopeGeneration: updated.generation,
        },
      },
      (root) => {
        const state = structuredClone(root.state!);
        const active = state.inputs?.find(
          (record) => record.runId === runId && record.status === "active",
        );
        if (
          root.archived ||
          root.execution_state !== "ready" ||
          root.active_run_id !== runId ||
          Number(root.scope_generation) !== updated.generation ||
          Number(root.branch_generation) !== input.branchGeneration ||
          active?.scopeGeneration !== input.scopeGeneration ||
          active.pendingScopeSelection !== input.pendingScopeSelection
        )
          throw new CodeUiRepositoryError(
            "command_conflict",
            "权限更新期间Task已停止或授权改变，输入未执行。",
          );
        // 只承接本次内部授权变化；外部撤权的代际不在此迁移。
        for (const record of state.inputs ?? [])
          if (
            ["active", "queued"].includes(record.status) &&
            record.scopeGeneration === input.scopeGeneration &&
            record.branchGeneration === input.branchGeneration
          )
            record.scopeGeneration = updated.generation;
        delete active.pendingScopeSelection;
        return { state, activeRunId: root.active_run_id };
      },
    );
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
      await this.applyInputScope(user, sessionId, runId);
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
      const workContext = workContextForRun(current.state!, runId);
      const frozenContributions = contributionsForRun(current.state!, runId);
      if (this.deps.captureContributions && !frozenContributions)
        throw new CodeUiRepositoryError(
          "command_conflict",
          "运行缺少能力快照，请重新提交输入。",
        );
      const providerPreset = workContextProviderPreset(workContext);
      const contextProvider = this.deps.workContextProvider?.(providerPreset);
      if (providerPreset === "design" && !contextProvider)
        throw new CodeUiRepositoryError(
          "command_conflict",
          "画布工作能力未加载，请检查插件设置。",
        );
      await contextProvider?.revalidate({
        actor: user,
        projectId: project.projectId,
        taskId: sessionId,
        runId,
        scopeGeneration: scopeHandle.describe().generation,
        branchGeneration: Number(current.branch_generation),
        context: workContext,
      });
      const approvalCeiling =
        current.state!.inputs?.find(
          (entry) =>
            entry.runId === runId && entry.intent.delivery.admitted !== "guide",
        )?.intent.mode ??
        current.state!.runApprovalCeilings?.find(([id]) => id === runId)?.[1];
      if (!approvalCeiling)
        throw new CodeUiRepositoryError(
          "command_conflict",
          "这条输入缺少发送时的执行权限，请重新发送。",
        );
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
              preset: workContext.preset,
              ...(workContext.canvasId
                ? { canvasId: workContext.canvasId }
                : {}),
              ...(workContext.imageGenerationPreference
                ? {
                    imageGenerationPreference:
                      workContext.imageGenerationPreference,
                  }
                : {}),
              ...(workContext.videoGenerationPreference
                ? {
                    videoGenerationPreference:
                      workContext.videoGenerationPreference,
                  }
                : {}),
              prompt: text,
              model,
            },
            {
              runId,
              threadId,
              scopeHandle,
              ...(root.state?.goalRecord?.runs?.some(
                (member) => member.runId === runId,
              )
                ? { goalId: root.state.goalRecord.goalId }
                : {}),
              workContext,
              ...(frozenContributions ? { frozenContributions } : {}),
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
              approvalCeiling,
              eventSink: async (event) =>
                this.recordRunEvent(
                  user,
                  project,
                  sessionId,
                  event.type === "run.usage" &&
                    modelInvocation?.contextWindow === undefined
                    ? await this.enrichRunUsageWindow(event, user, model)
                    : event,
                  ++ordinal,
                ),
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
      await this.resumeGoal(user, sessionId).catch((error: unknown) =>
        console.warn("[code-ui] Goal continuation admission失败：", error),
      );
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
          goals: this.goals,
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
    const projects = [
      ...(await this.deps.projects.listProjects(user, "code")),
      ...(await this.deps.projects.listProjects(user, "design")),
    ];
    const unique = new Map(
      projects
        .filter((project) => project.kind !== "flow")
        .map((project) => [project.id, project]),
    );
    return [...unique.values()].map((project) => ({
      projectId: project.id,
      name: project.name,
      kind: project.kind as "code" | "design",
      enabledModes: project.enabledModes?.filter(
        (mode) => mode === "code" || mode === "design",
      ),
      path:
        project.workDir ??
        resolve(
          this.deps.env.sandboxRoot ?? DEFAULT_SANDBOX_ROOT,
          user.instanceId,
          project.id,
        ),
      additionalDirectories: project.additionalDirectories,
    }));
  }

  private async prepareWorkContext(
    actor: LocalActor,
    projectId: string,
    requested: protocol.ConversationWorkContext | undefined,
    taskId?: string,
  ) {
    const context = freezeWorkContext(requested);
    const projects = await this.deps.projects.listProjects(
      actor,
      context.preset,
    );
    if (!projects.some((project) => project.id === projectId))
      throw new CodeUiRepositoryError(
        "command_conflict",
        "项目尚未启用此工作方式，请先在项目中开启。",
      );
    const providerPreset = workContextProviderPreset(context);
    const provider = this.deps.workContextProvider?.(providerPreset);
    if (providerPreset === "design" && !provider)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "画布工作能力未加载，请检查插件设置。",
      );
    const prepared = freezeWorkContext(
      provider
        ? await provider.prepare({
            actor,
            projectId,
            ...(taskId ? { taskId } : {}),
            context,
          })
        : context,
    );
    if (prepared.preset !== context.preset)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "工作能力返回了不同的工作方式，请检查插件设置。",
      );
    return prepared;
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

  private requireGoalFence(
    goal: CodeUiConversationState["goalRecord"],
    control: CodeGoalControl | undefined,
  ) {
    const expected = control?.expectedGoal;
    if (
      !control ||
      (goal
        ? !expected ||
          expected.goalId !== goal.goalId ||
          expected.revision !== goal.revision
        : expected !== null)
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "目标已改变，请刷新后重新提交目标",
      );
  }

  private async prepareGoalModel(
    user: LocalActor,
    state: CodeUiConversationState,
  ): Promise<CodePreparedModel> {
    const model = state.goalModel;
    if (!model || model.goalId !== state.goalRecord?.goalId)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "目标缺少模型快照，当前目标无法直接恢复",
      );
    const available = await this.deps.modelCatalog.validateSpecifier(
      user,
      `${model.invocation.providerId}:${model.invocation.modelId}`,
    );
    if (!available.ok)
      throw new CodeUiRepositoryError("command_conflict", available.message);
    const current = await this.deps.modelProviders.resolveCredentials(
      user,
      model.invocation.providerId,
    );
    if (
      current.instanceId !== model.invocation.providerId ||
      current.configRevision !== model.invocation.configRevision
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "目标模型配置已改变，当前目标无法直接恢复",
      );
    return {
      selection: structuredClone(model.selection),
      modelInvocation: structuredClone(model.invocation),
    };
  }

  private async pauseGoalForModel(
    user: LocalActor,
    root: NonNullable<Awaited<ReturnType<CodeUiRepository["find"]>>>,
    goal: NonNullable<CodeUiConversationState["goalRecord"]>,
    error: unknown,
  ) {
    await this.deps.repository.appendEvent(
      user.instanceId,
      root.id,
      {
        key: `goal-model-invalid:${goal.goalId}:${goal.revision}`,
        fingerprint: `${goal.goalId}:${goal.revision}`,
        event: {
          type: "goal.modelInvalid",
          goalId: goal.goalId,
          revision: goal.revision,
        },
      },
      (current) => {
        const state = structuredClone(current.state!);
        if (
          state.goalRecord?.goalId === goal.goalId &&
          state.goalRecord.revision === goal.revision &&
          !current.active_run_id
        ) {
          pauseTaskGoal(
            state,
            current.id,
            "goal.modelInvalid",
            Date.now(),
            this.goals,
          );
          const snapshot = state.snapshots.find(
            (item) => item.sessionId === current.id,
          )!;
          snapshot.control.lastError = {
            code: "goal.modelInvalid",
            message:
              error instanceof CodeUiRepositoryError
                ? error.message
                : "目标模型暂不可用，请稍后重试恢复",
            recoverable: true,
            at: Date.now(),
            source: "runtime",
          };
          snapshot.revision += 1;
          snapshot.seq += 1;
        }
        return { state, activeRunId: current.active_run_id };
      },
    );
    await this.refreshTaskProjection(
      user.instanceId,
      root.root_directory!,
      root.project_id,
    );
  }

  private async prepareInputModel(
    user: LocalActor,
    selection: protocol.SessionConfigState["modelSelection"],
  ): Promise<CodePreparedModel> {
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
    const prepared = await this.prepareSessionCreation(user, envelope);
    if (prepared.publish)
      void prepared
        .publish()
        .catch((error: unknown) =>
          console.warn("[code-ui] 创建首条输入派发失败：", error),
        );
    return prepared.result;
  }

  private async prepareSessionCreation(
    user: LocalActor,
    envelope: protocol.CommandEnvelope,
  ): Promise<{ result: protocol.CommandAck; publish?: () => Promise<void> }> {
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
  ): Promise<{ result: protocol.CommandAck; publish?: () => Promise<void> }> {
    await this.initialize();
    const payload = protocol.commandPayloadSchemas.createSession.parse(
      envelope.payload,
    );
    const project = await this.requireWorkspace(user, payload.workspaceId);
    const workspace = await this.deps.localInstance.resolve(user);
    const command = {
      clientId: envelope.clientId,
      commandId: envelope.commandId,
      fingerprint: codeUiCommandFingerprint(envelope),
    };
    const readReceipt = () =>
      this.deps.repository.readCreationCommand(
        workspace.instanceId,
        project.projectId,
        command,
      );
    const replay = await readReceipt();
    if (replay) return { result: replay };
    let creation: Parameters<CodeUiRepository["createRoot"]>[1] | undefined;
    try {
      creation = await this.prepareCreatedSession(
        user,
        payload,
        project,
        workspace.instanceId,
        command,
      );
      return await this.commitCreatedSession(
        user,
        project,
        workspace.instanceId,
        creation,
      );
    } catch (error) {
      const raced = await readReceipt();
      if (raced)
        return creation
          ? this.resolveCreatedSessionReceipt(user, creation, raced)
          : { result: raced };
      throw error;
    }
  }

  private async prepareCreatedSession(
    user: LocalActor,
    payload: protocol.CommandPayloadMap["createSession"],
    project: CodeUiWorkspace,
    instanceId: string,
    command: { clientId: string; commandId: string; fingerprint: string },
  ): Promise<Parameters<CodeUiRepository["createRoot"]>[1]> {
    const firstInput = payload.firstInput
      ? protocol.commandPayloadSchemas.sendText.parse({
          ...payload.firstInput,
          requestedDelivery: "startNow",
          workContext: payload.firstInput.workContext ?? payload.workContext,
        })
      : undefined;
    if (
      firstInput &&
      !firstInput.text.trim() &&
      !firstInput.attachments?.length
    )
      throw new CodeUiRepositoryError("command_conflict", "消息不能为空");
    if (firstInput?.attachments?.length)
      throw new CodeAttachmentError(
        "fault.attachment.notAuthorized",
        "请先在会话中上传附件再发送。",
        404,
      );
    const workContext = await this.prepareWorkContext(
      user,
      project.projectId,
      firstInput?.workContext ?? payload.workContext,
    );
    const requestedSelection =
      firstInput?.modelSelection ?? payload.config?.modelSelection;
    const views = await this.modelViews(user, requestedSelection);
    const selection = requestedSelection ?? views.selection.preferredSelection;
    const prepared = firstInput
      ? await this.prepareInputModel(user, selection)
      : undefined;
    const frozenContributions = firstInput
      ? this.deps.captureContributions?.(workContext.preset)
      : undefined;
    const creation = await this.prepareCreatedTask(
      user,
      payload,
      project,
      instanceId,
      workContext,
      selection,
    );
    return {
      ...creation,
      command,
      ...(firstInput && prepared
        ? {
            initializeInput: (root: CodeUiSessionRecord) =>
              this.initializeCreatedInput(
                root,
                command,
                firstInput,
                prepared,
                workContext,
                frozenContributions,
              ),
          }
        : {}),
    };
  }

  private async prepareCreatedTask(
    user: LocalActor,
    payload: protocol.CommandPayloadMap["createSession"],
    project: CodeUiWorkspace,
    instanceId: string,
    workContext: protocol.ConversationWorkContext,
    selection: protocol.SessionConfigState["modelSelection"],
  ) {
    const sessionId = randomUUID();
    const record = await this.deps.projects.getProject(user, project.projectId);
    const additionalDirectories = record.additional_directories ?? [];
    const rootDirectory = await resolveProjectWorkDirectory({
      instanceId,
      projectId: project.projectId,
      sandboxRoot: this.deps.env.sandboxRoot ?? DEFAULT_SANDBOX_ROOT,
      workDir: record.work_dir,
    });
    const execution = resolveExecutionState({
      ...(payload.config?.mode !== undefined
        ? { mode: payload.config.mode }
        : {}),
      ...(payload.config?.planEnabled !== undefined
        ? { planEnabled: payload.config.planEnabled }
        : {}),
    });
    const host = createCodeUiConversation({
      goals: this.goals,
      sessionId,
      workspacePath: rootDirectory,
      workContext,
      config: {
        provider: "zcode",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
        ...(selection ? { modelSelection: selection } : {}),
        followupMode: payload.config?.followupMode ?? "queue",
        mode: protocol.commandPayloadSchemas.switchCollaborationMode.parse({
          mode: execution.mode,
        }).mode,
        planEnabled: execution.planEnabled,
      },
    });
    return {
      sessionId,
      projectId: project.projectId,
      scope: {
        instanceId,
        projectId: project.projectId,
        taskId: sessionId,
        // 授权版本从 1 起铸：Windows 原生 broker 拒绝 generation<=0（「Task 执行身份
        // 或授权版本无效」），0 起铸会让首个 run/终端直接被沙箱挡掉。
        generation: 1,
        rootDirectory,
        additionalDirectories,
        sandboxMode:
          execution.mode === "yolo" ? "danger-full-access" : "workspace-write",
      } satisfies CodeExecutionScope,
      createdByClientId: user.accessClientId,
      threadId: this.deps.threads.createThreadId(),
      state: host.exportState(),
    };
  }

  private initializeCreatedInput(
    root: CodeUiSessionRecord,
    command: { clientId: string; commandId: string },
    payload: Pick<
      protocol.CommandPayloadMap["sendText"],
      "text" | "requestedDelivery" | "mode" | "planEnabled"
    >,
    prepared: CodePreparedModel,
    workContext: protocol.ConversationWorkContext,
    frozenContributions?: ToolContributionSnapshot,
  ) {
    const snapshot = root.state?.snapshots.find(
      (entry) => entry.sessionId === root.id,
    );
    if (!snapshot || !root.state || !root.root_directory)
      throw new CodeUiRepositoryError(
        "not_found",
        "新 Task 根快照或目录不存在。",
      );
    const config = snapshot.config;
    const initial = createCodeUiConversation({
      goals: this.goals,
      sessionId: root.id,
      workspacePath: root.root_directory,
      config,
      state: root.state,
    });
    const { execution, requestedSandboxMode } = prepareCodeInputExecution(
      config,
      payload,
    );
    const input = prepareCodeInputRecord({
      command,
      payload,
      kind: "sendText",
      attachments: [],
      selection: prepared.selection,
      execution,
      workContext,
      modelInvocation: prepared.modelInvocation,
      ...(frozenContributions ? { frozenContributions } : {}),
      runId: randomUUID(),
      scopeGeneration: Number(root.scope_generation),
      branchGeneration: Number(root.branch_generation),
      delivery: "startNow",
      admissionSeq: 1,
      queuePosition: 0,
      ...(requestedSandboxMode ? { requestedSandboxMode } : {}),
    });
    initial.admitInput(input, this.inputOwner);
    initial.startInput(input);
    return {
      state: initial.exportState(),
      activeRunId: input.runId,
      inputId: command.commandId,
    };
  }

  private async commitCreatedSession(
    user: LocalActor,
    project: CodeUiWorkspace,
    instanceId: string,
    creation: Parameters<CodeUiRepository["createRoot"]>[1],
  ): Promise<{ result: protocol.CommandAck; publish?: () => Promise<void> }> {
    const { command } = creation;
    let ack: protocol.CommandAck;
    try {
      ack = await this.deps.repository.createRoot(instanceId, creation);
    } catch (error) {
      const persisted = await this.deps.repository.readCreationCommand(
        instanceId,
        project.projectId,
        command,
      );
      if (!persisted) throw error;
      ack = persisted;
    }
    return this.resolveCreatedSessionReceipt(user, creation, ack);
  }

  private resolveCreatedSessionReceipt(
    user: LocalActor,
    creation: Parameters<CodeUiRepository["createRoot"]>[1],
    ack: protocol.CommandAck,
  ): { result: protocol.CommandAck; publish?: () => Promise<void> } {
    const { command, sessionId } = creation;
    // 不确定提交仅由本次确实创建的 Task 保留派发权；并发失败者和普通重放不能派发。
    const ownsFirstInput =
      creation.initializeInput &&
      (ack.status === "accepted" || ack.status === "duplicate") &&
      !ack.reasonCode &&
      ack.result?.type === "createSession" &&
      ack.result.sessionId === sessionId;
    return {
      result:
        ownsFirstInput && ack.status === "duplicate"
          ? { ...ack, status: "accepted" }
          : ack,
      ...(ownsFirstInput
        ? {
            publish: publishOnce(() =>
              this.publishCreatedInput(user, sessionId, command),
            ),
          }
        : {}),
    };
  }

  private async publishCreatedInput(
    user: LocalActor,
    taskId: string,
    command: { clientId: string; commandId: string },
  ): Promise<void> {
    let loaded: Awaited<ReturnType<CodeUiService["loadConversation"]>>;
    try {
      loaded = await this.loadConversation(user, taskId);
    } catch (error) {
      if (error instanceof CodeUiRepositoryError && error.code === "not_found")
        return;
      throw error;
    }
    const record = loaded.root;
    const input = record.state?.inputs?.find(
      (entry) =>
        entry.intent.clientId === command.clientId &&
        entry.intent.sourceCommandId === command.commandId,
    );
    if (
      !input ||
      input.status !== "active" ||
      record.active_run_id !== input.runId ||
      record.archived ||
      record.execution_state !== "ready"
    )
      return;
    const selection = input.intent.modelSelection;
    if (!selection)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "首条输入缺少模型选择。",
      );
    const thread = await this.deps.threads.resolveOwnedSessionThread(
      user,
      taskId,
    );
    await this.refreshTaskProjection(
      loaded.instanceId,
      loaded.project.path,
      loaded.project.projectId,
    );
    await this.notifyTask(user, loaded.project, taskId, "task_created");
    await this.runTurn(
      user,
      loaded.project,
      taskId,
      thread.threadId,
      input.runId,
      input.intent.text,
      `${selection.providerId}:${selection.modelId}`,
      input.modelInvocation,
    );
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
    // 旧恢复投影先按取消收尾；Run账本的启动对账在listen之后才写入失败。
    // 仅同一Run的持久失败可恢复原因，无原因取消保留原终态。
    if (
      snapshot.control.phase === "completedInterrupted" &&
      !snapshot.control.lastError &&
      root.state.runId
    ) {
      const failure = await this.deps.repository.readRunFailure(
        workspace.instanceId,
        root.id,
        root.state.runId,
      );
      if (failure) {
        snapshot.control = {
          ...snapshot.control,
          phase: "error",
          sessionEnded: false,
          lastError: {
            code: failure.error_code ?? "run_failed",
            message: failure.error_message,
            recoverable: true,
            at: failure.completed_at
              ? new Date(failure.completed_at).getTime()
              : new Date(root.updated_at).getTime(),
            source: "runtime",
          },
        };
        snapshot.queue.pauseReason = "error";
      }
    }
    if (
      root.state.goalRecord &&
      root.state.inputOwner?.hostId === this.inputOwner.hostId &&
      root.state.inputOwner.runtimeId !== this.inputOwner.runtimeId &&
      ["active", "verifying", "notSatisfied"].includes(
        root.state.goalRecord.status,
      )
    ) {
      await this.deps.repository.appendEvent(
        workspace.instanceId,
        root.id,
        {
          key: `goal-recover:${this.inputOwner.runtimeId}`,
          fingerprint: this.inputOwner.runtimeId,
          event: { type: "goal.recover" },
        },
        (current) => {
          const state = structuredClone(current.state!);
          if (
            state.goalRecord &&
            state.inputOwner?.runtimeId !== this.inputOwner.runtimeId
          )
            state.goalRecord = this.goals.recover(
              state.goalRecord,
              new Date(current.updated_at).getTime(),
            );
          syncGoal(state, current.id);
          return { state, activeRunId: current.active_run_id };
        },
      );
      const recovered = await this.deps.repository.find(
        workspace.instanceId,
        root.id,
      );
      if (recovered?.state) root.state = recovered.state;
    }
    const host = createCodeUiConversation({
      goals: this.goals,
      sessionId: root.id,
      workspacePath: project.path,
      config: snapshot.config,
      state: root.state,
      taskControl: {
        projectId: root.project_id,
        branchGeneration: Number(root.branch_generation),
      },
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
    await this.historyFork.decorate(user, loaded, snapshot);
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
