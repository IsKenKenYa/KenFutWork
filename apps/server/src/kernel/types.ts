import type { StreamEvent } from "@kenfutwork/shared";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import type { FastifyInstance } from "fastify";
import type { ZodTypeAny } from "zod";
import type { AgentBackendFactory } from "../agent/backends/index.js";
import type { AgentPersistenceService } from "../agent/persistence/index.js";
import type { AgentRunService } from "../agent/runtime.js";
import type { ServerEnv } from "../config/env.js";
import type { ExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type { BlobStore } from "../features/blob/types.js";
import type { BrandKitService } from "../features/brand-kit/brand-kit-service.js";
import type { BrowserService } from "../features/browser/fetch-page.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { ChatService } from "../features/chat/chat-service.js";
import type { ThreadService } from "../features/chat/thread-service.js";
import type { CheckpointService } from "../features/checkpoints/checkpoint-service.js";
import type { CodeGitService } from "../features/code-git/code-git-service.js";
import type { CodeTerminalService } from "../features/code-terminal/types.js";
import type { CodeUiService } from "../features/code-ui/service.js";
import type {
  ExecutionScopeHandle,
  ExecutionScopes,
} from "../features/execution/scope-service.js";
import type {
  PersistImageFn,
  SubmitImageJobFn,
  SubmitVideoJobFn,
} from "../features/generation/tool-types.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { LocalAccessService } from "../features/local-access/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../features/local-instance/types.js";
import type { ModelCatalogService } from "../features/model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type {
  CodeApprovalMode,
  CodePlanControl,
  PermissionInvocation,
} from "../features/permissions/approval-types.js";
import type { PermissionService } from "../features/permissions/permission-service.js";
import type { PersistenceService } from "../features/persistence/types.js";
import type { PluginRegistryService } from "../features/plugins/plugin-registry-service.js";
import type { ProcessSandbox } from "../features/process-sandbox/types.js";
import type { ProjectService } from "../features/projects/project-service.js";
import type { QueueClient } from "../features/queue/types.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import type {
  TaskWorkContext,
  TaskWorkManager,
} from "../features/task-work/types.js";
import type { AssetWriter } from "../features/uploads/asset-writer.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type { RunUsageAccumulator } from "../features/usage/run-usage-accumulator.js";
import type { UsageService } from "../features/usage/usage-service.js";
import type {
  AvailableModel,
  AvailableVideoModel,
} from "../generation/types.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import type { CanvasEventBuffer } from "../ws/event-buffer.js";
import type { ResourceDisposer } from "./disposal.js";

/**
 * 内核服务仓库（ctx key 表的唯一代码落点）。
 *
 * `ServiceKey` 是**封闭联合**：新增行为一律挂到注册表型 key（tools/capabilities），
 * 需要 key 扩展时改本表（契约属主见《改造计划》§4.2），禁止业务代码自造 key。
 */
export interface ServiceMap {
  /** agent 后端工厂 */
  backend: AgentBackendFactory;
  /** agent 运行时三件套 */
  agentPersistence: AgentPersistenceService;
  agentRunMetadata: AgentRunMetadataService;
  agentRuns: AgentRunService;
  /** 领域服务（design 侧为主） */
  brandKit: BrandKitService;
  canvas: CanvasService;
  chat: ChatService;
  /**
   * Code 模式的 git 分支视图（工作目录=项目）：列分支 / 切分支。
   * 目录经 `resolveSandboxDir` 解析（与 agent 后端同一处），归属校验在服务内。
   */
  codeGit: CodeGitService;
  codeUi: CodeUiService;
  codeTerminal: CodeTerminalService;
  executionScopes: ExecutionScopes;
  processSandbox: ProcessSandbox;
  taskWork: TaskWorkManager;
  /**
   * Code 模式检查点（影子 git 快照/预览/恢复）：runtime 轮次钩子与恢复路由消费。
   * 影子仓库在服务端数据目录（GIT_DIR），work-tree 指向沙箱工作目录
   * （经 `resolveSandboxDir` 同一处解析）。
   */
  checkpoints: CheckpointService;
  projects: ProjectService;
  settings: SettingsService;
  threads: ThreadService;
  uploads: UploadService;
  /**
   * 生成物元数据写入缝（worker/executor 路径）：executor 无用户身份、也无 viewer，
   * 只能按任务记录里的工作区写 `asset_objects`——与 `uploads`（身份取自鉴权用户）
   * 同表不同口径，故独立成 key，且 worker profile 也能装配（§4.2）。
   */
  assetWriter: AssetWriter;
  /**
   * blob 缝（M3.1）：对象存储唯一入口；Provider 随形态替换
   * （当前本地FS；远端对象存储按未来连接边界独立接入）。
   */
  blob: BlobStore;
  localInstance: LocalInstanceService;
  /**
   * 自管 Postgres 存储缝（§4.2；`FORM-9`）：唯一 DB 入口，实例隔离在
   * 应用层强制（DB 层已无 RLS 兜底）。Provider 随形态替换（桌面捆绑 / 自托管）。
   */
  persistence: PersistenceService;
  /** 回环本机Cookie/Bearer接入；不代表官方账户。 */
  localAccess: LocalAccessService;
  /** JobService（PGMQ，Postgres 扩展） */
  jobs: JobService;
  /**
   * 队列缝（M3.2）：任务投递与消费的唯一入口；Provider 随形态替换
   * （`pgmq` 服务端/自托管 / `in-process` 桌面）。
   */
  queue: QueueClient;
  /** 用户供应商实例管理（CRUD + 凭证解析，BYOK） */
  modelProviders: ModelProviderService;
  /** 模型目录（从用户供应商实例推导） */
  modelCatalog: ModelCatalogService;
  /** 用量计量服务（DEC-6） */
  usage: UsageService;
  /** 跨模式 tool-call 策略缝（DEC-4） */
  permissions: PermissionService;
  /**
   * 插件注册表缝：第三方/内置插件的目录、安装（含安装前兼容性门禁）、
   * 启停与导出。插件代码是机器本地的，安装态落在 pluginsDir。
   */
  plugins: PluginRegistryService;
  /** 执行模式缝（DEC-3：v1 agent + plan） */
  agentModes: ExecutionModeService;
  /** agent 链路 run 用量累积器（turn-stopping 结算） */
  runUsage: RunUsageAccumulator;
  /** 能力贡献者注册表（非工具能力：子代理 provider、执行模式等） */
  capabilities: CapabilityRegistry;
  /** 统一工具注册表（schema + 作用域 + guarded 执行） */
  tools: ToolRegistry;
  /** 系统提示段注册表（模式段/品牌段/skills/规则与插件段，挂载即出现） */
  systemPrompt: SystemPromptRegistry;
  /** 浏览器能力缝（R3-4/R5-4）：受控网页抓取与元素提取（人用快照端点、agent 用 browser_open） */
  browser: BrowserService;
  /** ConnectionManager + EventBuffer */
  ws: WsServices;
}

export interface WsServices {
  connectionManager: ConnectionManager;
  eventBuffer: CanvasEventBuffer;
}

export type ServiceKey = keyof ServiceMap;

export type ServiceOf<K extends ServiceKey> = ServiceMap[K];

/**
 * 插件工厂拿到的依赖解析器；只能解析 ServiceKey，未注册即 fail loud。
 * `_K` 是「本工厂提供哪个服务」的幻影标记：解析器可解析任意 key，故类型参数不参与结构。
 */
export type DepsOf<_K extends ServiceKey> = {
  get: <D extends ServiceKey>(key: D) => ServiceMap[D];
};

/**
 * agent-run 最小事件缝（DEC-1）：只有 3 个事件，不建通用事件总线。
 * waterfall 监听器必须调 next() 委托；不调即拦截后续监听器。
 */
export type AgentRunEvent = "pre-step" | "tool-pre-execute" | "turn-stopping";

export interface PreStepPayload {
  input: unknown;
  runId: string | undefined;
  threadId?: string | undefined;
  /** Runtime已接受的run/Task事实，仅供指导hydrate；不作为工具执行授权。 */
  preset?: "design" | "code" | undefined;
  instanceId?: string | undefined;
  taskId?: string | undefined;
  sessionId?: string | undefined;
}

export interface ToolPreExecutePayload {
  permissionInvocation?: PermissionInvocation | undefined;
  args: Record<string, unknown>;
  decision: "allow" | "deny";
  denyReason?: string | undefined;
  runId: string | undefined;
  /** 会话线程（执行模式等按线程拦截的监听器据此取策略）。 */
  threadId?: string | undefined;
  toolName: string;
}

export interface TurnStoppingPayload {
  runId: string;
}

export interface AgentRunEventPayloads {
  "pre-step": PreStepPayload;
  "tool-pre-execute": ToolPreExecutePayload;
  "turn-stopping": TurnStoppingPayload;
}

export type WaterfallListener<E extends AgentRunEvent> = (
  payload: AgentRunEventPayloads[E],
  next: (
    payload: AgentRunEventPayloads[E],
  ) => Promise<AgentRunEventPayloads[E]>,
) => Promise<AgentRunEventPayloads[E]>;

export type SerialListener<E extends AgentRunEvent> = (
  payload: AgentRunEventPayloads[E],
  next: () => Promise<void>,
) => Promise<void>;

/** `turn-stopping` 是 serial，其余两个是 waterfall。 */
export type ListenerOf<E extends AgentRunEvent> = E extends "turn-stopping"
  ? SerialListener<E>
  : WaterfallListener<E>;

/** 工具作用域：preset 按此过滤各自工具子集（shared 恒可用）。 */
export type ToolScope = "design" | "code" | "shared";

/** 提示段作用域：always 恒挂；design/code 按 run 的 preset 过滤（模式段互斥）。 */
export type PromptSectionScope = "always" | "design" | "code";

/**
 * 提示段组装上下文：run 起始期已解析的**事实**（preset、工作区、套件绑定、
 * 技能清单）。需要服务自取数据的段（用户规则、插件提示段）在 provider 闭包里
 * 持有服务引用，按 ctx 定位——ctx 不装「已取好的数据」，只装定位键。
 */
export interface PromptCompositionContext {
  /** 私有执行定位；从实际Run复制，不由模型或路径签发，不缓存业务正文。 */
  execution?: PromptExecutionContext | undefined;
  executionScope?: import("@kenfutwork/shared").CodeExecutionScope | undefined;
  executionRole?:
    | import("../features/execution/scope-service.js").ExecutionRole
    | undefined;
  approvalMode?: CodeApprovalMode | undefined;
  approvalCeiling?: CodeApprovalMode | undefined;
  planEnabled?: boolean | undefined;
  roleInstructions?: string | undefined;
  projectInstructions?:
    | ReadonlyArray<
        import("../features/code-tools/project-instructions-types.js").CodeProjectInstruction
      >
    | undefined;
  projectContextIssues?:
    | ReadonlyArray<{ path: string; message: string }>
    | undefined;
  projectContextTruncated?: boolean | undefined;
  preset: "design" | "code";
  /** 工作区 id：规则段等按工作区读取设置的定位键。 */
  instanceId?: string | undefined;
  /** 项目绑定的品牌套件 id（品牌段出现与否的判定）。 */
  brandKitId?: string | undefined;
  /** 工作区技能清单（skills 段渲染；结构取 WorkspaceSkillEntry 的消费子集）。 */
  instanceSkills?: ReadonlyArray<{
    name: string;
    description: string;
    path: string;
    files: ReadonlyArray<{ path: string }>;
  }>;
  /**
   * 用户规则段（run 起始期事实）：runtime 读 settings 的同一趟顺带格式化取出
   * （autoCompact/hooks 同源），段 provider 纯渲染——避免段内二次读库。
   */
  userRulesFragment?: readonly string[];
}

export type PromptExecutionContext = Pick<
  ToolExecutionContext,
  "actor" | "scopeHandle" | "taskWorkContext" | "runId" | "signal"
>;

/**
 * 系统提示段（dsh PromptSection 式）：插件向 `ctx.systemPrompt` 贡献，
 * 挂载即出现、卸载即消失。`resolve` 返回 null/空白 = 本 run 不出现该段。
 */
export interface PromptSectionDefinition {
  /** 段名（唯一，重名 fail loud；用于排查，不进模型可见文本）。 */
  name: string;
  /** 升序拼装，同 order 按注册序。内置段约定：base=-100 / 模式段=0 / 品牌=50 / skills=200 / 规则与插件=300。 */
  order: number;
  scope: PromptSectionScope;
  resolve: (
    ctx: PromptCompositionContext,
  ) => string | null | Promise<string | null>;
}

/** 系统提示段注册表：组装 = scope 过滤 + order 排序 + 空段剔除 + join。 */
export interface SystemPromptRegistry {
  /** 注册提示段，返回注销 disposer；重名 fail loud。 */
  register(section: PromptSectionDefinition): () => void;
  /** 组装本 run 的系统提示（各段 resolve 可异步）。 */
  compose(ctx: PromptCompositionContext): Promise<string>;
}

export interface ToolExecutionContext {
  /** 真实Run持久事件消费方；出口工具复用此通路，不持有已结束的SDK子run回调。 */
  publishToolEvent?:
    | ((
        event: Extract<
          StreamEvent,
          { type: "tool.started" | "tool.completed" }
        >,
      ) => Promise<void>)
    | undefined;
  /** 完成绑定审批的原调用事实；属主按原始效果收窄执行，不能把旧只读批准扩大。 */
  permissionInvocation?: PermissionInvocation | undefined;
  /** 最终claim固定的执行效果档；原plan或最终plan始终夹到只读。 */
  approvedExecutionMode?: CodeApprovalMode | undefined;
  /** 私有宿主事实：每次执行重新读 Task policy，worker ceiling 在派发时冻结。 */
  codeApproval?:
    | {
        ceiling: CodeApprovalMode;
        resolve(): Promise<{
          mode: CodeApprovalMode;
          /** 独立规划状态；mode是逐调用派生的有效权限档。 */
          planEnabled?: boolean | undefined;
          planningEpoch?: number | undefined;
          scopeGeneration: number;
          branchGeneration: number;
        }>;
      }
    | undefined;
  sessionId?: string | undefined;
  modelSpecifier?: string | undefined;
  delegationDepth?: number | undefined;
  taskWorkContext?: TaskWorkContext | undefined;
  runId?: string | undefined;
  /** 实际模型工具调用身份：幂等、真实 diff 与 UI 事件共用。 */
  toolCallId?: string | undefined;
  scopeHandle?: ExecutionScopeHandle | undefined;
  signal?: AbortSignal | undefined;
  /** 会话线程：tool-pre-execute 监听器（执行模式拦截）据此定位线程策略。 */
  threadId?: string | undefined;
  instanceId?: string | undefined;
  /**
   * 运行方用户 id：需要用户身份的工具（画布截图 RPC 路由、品牌套件 `:user`
   * 隔离谓词）据此构造调用方，与 instanceId 同为 run 起始期一次性解析。
   */
  actor?: LocalActor | undefined;
  /**
   * 本轮 run 绑定的画布：需要落点的工具（如 install_plugin 从工作目录安装）
   * 据此解析沙箱目录——解析口径与 agent/git 同一处（resolveSandboxDir）。
   */
  canvasId?: string | undefined;
  /** 运行方（agent 运行时）传入的请求级用户令牌；需要用户上下文的工具据此解析数据。 */
  /**
   * 附件 assetId → data URI 映射（run 附件下载产物）：generate_image 的
   * 参考图解析经它。桥接层从 LangChain invoke 期的 configurable 透传——
   * execCtx 本体在装配期构建时它尚不可得。
   */
  userAttachmentMap?: Record<string, string> | undefined;
}

/**
 * 模型可调用工具（`ctx.tools` 贡献条目）。
 * `parameters` 是模型可见的 JSON Schema；入参校验由 execute 内部负责。
 * MCP 工具命名约定：`mcp__<server>__<tool>`。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  scope: ToolScope;
  exposure?: "core" | "deferred" | undefined;
  /** 执行效果由可信属主声明；未知外部工具不能进入只读角色。 */
  access?: "read" | "write" | "execute" | undefined;
  /** 有限Task控制；不得与资源access混合或从外部MCP字段签发。 */
  planControl?: CodePlanControl | undefined;
  /** 仅可信执行属主签发：只读文件域且网络禁用，不来自模型参数。 */
  readonlyExecution?: boolean | undefined;
  parameters: Record<string, unknown>;
  /** 仅用于公开事件/显示/日志；执行与审批仍使用原始参数。 */
  projectArguments?:
    | ((args: Record<string, unknown>) => Record<string, unknown>)
    | undefined;
  /**
   * 原生 zod schema（内置工具专用逃生口）：桥接层优先用它构造 StructuredTool，
   * 避免 zod → JSON Schema → zod 往返丢精度（default/union/enum）。
   * 缺省（如 MCP 工具）仍走 parameters 的 JSON Schema 转换。
   */
  zodSchema?: ZodTypeAny | undefined;
  execute(
    args: Record<string, unknown>,
    execCtx: ToolExecutionContext,
  ): Promise<unknown>;
}

export interface ToolRegistry {
  /** 注册工具，返回注销 disposer；重名 fail loud。 */
  register(tool: ToolDefinition): () => void;
  get(name: string): ToolDefinition | undefined;
  require(name: string): ToolDefinition;
  /** 列出工具；指定 scope 时返回该 scope + shared 子集。 */
  list(scope?: ToolScope): ToolDefinition[];
  /** guarded 执行：先派发 `tool-pre-execute` 事件，deny 即拒绝。 */
  execute(
    name: string,
    args: Record<string, unknown>,
    execCtx?: ToolExecutionContext,
  ): Promise<unknown>;
  /**
   * guarded 执行任意工具实例（含 per-run 动态解析的产物——它们不在静态
   * 注册表里，`execute(name)` 查不到）。拦截语义与 execute 一致。
   */
  executeDefinition(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    execCtx?: ToolExecutionContext,
  ): Promise<unknown>;
  /**
   * 注册 per-run 动态工具：resolve 在每次 run 起始期调用（runtime 传入
   * 运行态依赖），返回 null = 本 run 不装配。静态工具装不下的东西
   * （动态 schema、闭包捕获 run 上下文、backend 绑定）走这条路。
   */
  registerDynamic(entry: DynamicToolEntry): () => void;
  /** 静态 list(scope) + 动态 per-run 解析合并，按 scope 过滤。 */
  resolveRunTools(ctx: RunToolResolutionContext): ToolDefinition[];
}

/** per-run 工具解析上下文：runtime 在 run 起始期构建，动态工具据此实例化。 */
export interface RunToolResolutionContext {
  sessionId?: string | undefined;
  modelSpecifier?: string | undefined;
  delegationDepth?: number | undefined;
  taskWorkContext?: TaskWorkContext | undefined;
  scopeHandle?: ExecutionScopeHandle | undefined;
  modelCapabilities?: { image: boolean; pdf: boolean } | undefined;
  preset: "design" | "code";
  /** deepagents backend 工厂（project_search 的 grep 虚拟工作区经它）。 */
  backendFactory: AgentBackendFactory;
  /** 本 run 后端的沙箱目录（dev=per-run tmp；prod=per-canvas 工作区）。 */
  sandboxDir?: string | undefined;
  /** 会话 store（backend 实例化入参）。 */
  store?: BaseStore | undefined;
  /** 生成图持久化闭包（blob 缝，捕获 run 工作区）。 */
  persistImage?: PersistImageFn | undefined;
  /** 图片生成 job 闭包（捕获 run 上下文，产物落画布）。 */
  submitImageJob?: SubmitImageJobFn | undefined;
  /** 视频生成 job 闭包。 */
  submitVideoJob?: SubmitVideoJobFn | undefined;
  /** 工作区实例的图片模型目录（generate_image 的动态 schema 来源）。 */
  availableImageModels?: AvailableModel[] | undefined;
  /** 工作区实例的视频模型目录。 */
  availableVideoModels?: AvailableVideoModel[] | undefined;
}

/** 动态工具条目：id 用于排查与注销；scope 参与与静态工具相同的 preset 过滤。 */
export interface DynamicToolEntry {
  id: string;
  scope: ToolScope;
  resolve: (ctx: RunToolResolutionContext) => ToolDefinition | null;
}

/** 非工具能力贡献者条目（由运行时按 key 解析，模型不可见）。 */
export interface CapabilityRegistration<T = unknown> {
  id: string;
  value: T;
}

/**
 * 能力贡献者注册表（`ctx.capabilities`）：开放贡献、封闭 key 的承载点。
 * 子代理 provider、执行模式等在此注册；同一 capability 可多 provider。
 */
export interface CapabilityRegistry {
  register<T>(
    capability: string,
    provider: CapabilityRegistration<T>,
  ): () => void;
  list<T>(capability: string): Array<CapabilityRegistration<T>>;
  get<T>(capability: string, id: string): T | undefined;
  require<T>(capability: string, id: string): T;
}

/** 插件定义：稳定 name + inject 依赖 + enabled 判定 + apply 挂载。 */
export interface PluginDefinition {
  name: string;
  inject: readonly ServiceKey[];
  enabled?: (env: ServerEnv) => boolean;
  apply(ctx: PluginContext): undefined | ResourceDisposer;
  /**
   * 全部插件 apply 完成、服务定例化就绪后按声明顺序调用。
   * 路由注册等「消费其他插件服务」的跨服务接线放这里，apply 只注册自己的服务。
   */
  mounted?(ctx: PluginContext): void;
}

export interface PluginContext {
  /** 注册服务工厂；同一 key 只允许注册一次（fail loud）。 */
  register<K extends ServiceKey>(
    key: K,
    factory: (deps: DepsOf<K>) => ServiceMap[K],
  ): void;
  /** 解析服务：overrides > 工厂惰性实例化；未注册即抛错。 */
  get<K extends ServiceKey>(key: K): ServiceMap[K];
  /** 可选解析：key 无人提供时返回 undefined（jobs 等条件装配服务用）。 */
  tryGet<K extends ServiceKey>(key: K): ServiceMap[K] | undefined;
  /** 登记可逆副作用，kernel dispose 时 LIFO 执行。 */
  effect(fn: () => undefined | ResourceDisposer): void;
  /** 订阅 agent-run 事件，返回取消订阅函数。 */
  on<E extends AgentRunEvent>(event: E, listener: ListenerOf<E>): () => void;
  /** Fastify 实例；worker 进程 compose 时不可用（访问即抛错）。 */
  readonly app: FastifyInstance;
  readonly env: ServerEnv;
}

/** 事件派发入口：agent 运行时（而非插件）在主循环挂钩处调用。 */
export interface KernelEvents {
  emitPreStep(payload: PreStepPayload): Promise<PreStepPayload>;
  emitToolPreExecute(
    payload: ToolPreExecutePayload,
  ): Promise<ToolPreExecutePayload>;
  emitTurnStopping(payload: TurnStoppingPayload): Promise<void>;
}

export interface KernelHandle {
  /** 逆序执行全部 disposer（apply 返回值 + effect + 工具/事件注销）。 */
  dispose(): Promise<void>;
  get<K extends ServiceKey>(key: K): ServiceMap[K];
  tryGet<K extends ServiceKey>(key: K): ServiceMap[K] | undefined;
  readonly events: KernelEvents;
}
