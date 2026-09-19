import type { FastifyInstance } from "fastify";

import type { AgentBackendFactory } from "../agent/backends/index.js";
import type { AgentPersistenceService } from "../agent/persistence/index.js";
import type { AgentRunService } from "../agent/runtime.js";
import type { ServerEnv } from "../config/env.js";
import type { AdminService } from "../features/admin/admin-service.js";
import type { ExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type { ApiTokenService } from "../features/api-tokens/token-service.js";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { BlobStore } from "../features/blob/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { BrandKitService } from "../features/brand-kit/brand-kit-service.js";
import type { BrowserService } from "../features/browser/fetch-page.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { ChatService } from "../features/chat/chat-service.js";
import type { ThreadService } from "../features/chat/thread-service.js";
import type { CheckpointService } from "../features/checkpoints/checkpoint-service.js";
import type { CodeGitService } from "../features/code-git/code-git-service.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { ModelCatalogService } from "../features/model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { PaymentService } from "../features/payments/payment-service.js";
import type { PermissionService } from "../features/permissions/permission-service.js";
import type { PersistenceService } from "../features/persistence/types.js";
import type { PluginRegistryService } from "../features/plugins/plugin-registry-service.js";
import type { ProjectService } from "../features/projects/project-service.js";
import type { QueueClient } from "../features/queue/types.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import type { AssetWriter } from "../features/uploads/asset-writer.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type { RunUsageAccumulator } from "../features/usage/run-usage-accumulator.js";
import type { UsageService } from "../features/usage/usage-service.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import type { CanvasEventBuffer } from "../ws/event-buffer.js";

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
  /** 计费三件套（目标态默认关闭，DEC-5） */
  credits: CreditService;
  tierGuard: TierGuard;
  payments: PaymentService;
  /** 平台管理后台（FORM-10：系统供应商分发 + 额度/套餐统一管理） */
  admin: AdminService;
  /** 领域服务（design 侧为主） */
  brandKit: BrandKitService;
  canvas: CanvasService;
  chat: ChatService;
  /**
   * Code 模式的 git 分支视图（工作目录=项目）：列分支 / 切分支。
   * 目录经 `resolveSandboxDir` 解析（与 agent 后端同一处），归属校验在服务内。
   */
  codeGit: CodeGitService;
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
   * （`local` 桌面本地 FS / `supabase` 过渡期与自托管现状 / 后续 MinIO）。
   */
  blob: BlobStore;
  viewer: ViewerService;
  /**
   * 自管 Postgres 存储缝（§4.2；`FORM-9`）：唯一 DB 入口，workspace 隔离在
   * 应用层强制（DB 层已无 RLS 兜底）。Provider 随形态替换（桌面捆绑 / 自托管）。
   */
  persistence: PersistenceService;
  /** 认证缝（目标 local-trust / 自管 auth） */
  auth: RequestAuthenticator;
  /**
   * 外部应用访问令牌（R5-2「外部应用授权」）：给外部应用/脚本/CI 用的 API 凭据。
   * 认证缝的第二条路径由 auth 插件合成消费（见 auth/plugin.ts）。
   */
  apiTokens: ApiTokenService;
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
}

export interface ToolPreExecutePayload {
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

export interface ToolExecutionContext {
  runId?: string | undefined;
  signal?: AbortSignal | undefined;
  /** 会话线程：tool-pre-execute 监听器（执行模式拦截）据此定位线程策略。 */
  threadId?: string | undefined;
  workspaceId?: string | undefined;
  /**
   * 本轮 run 绑定的画布：需要落点的工具（如 install_plugin 从工作目录安装）
   * 据此解析沙箱目录——解析口径与 agent/git 同一处（resolveSandboxDir）。
   */
  canvasId?: string | undefined;
  /** 运行方（agent 运行时）传入的请求级用户令牌；需要用户上下文的工具据此解析数据。 */
  accessToken?: string | undefined;
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
  parameters: Record<string, unknown>;
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
  apply(ctx: PluginContext): undefined | (() => void);
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
  effect(fn: () => undefined | (() => void)): void;
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
  dispose(): void;
  get<K extends ServiceKey>(key: K): ServiceMap[K];
  tryGet<K extends ServiceKey>(key: K): ServiceMap[K] | undefined;
  readonly events: KernelEvents;
}
