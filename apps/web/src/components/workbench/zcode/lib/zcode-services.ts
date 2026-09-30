/**
 * zcode 宿主适配 stub：`@zcode/services` 的最小类型等价（只收录照搬组件实际消费的切片）。
 * 来源：references/zcode/packages/services（ISubagentsService / IServiceAccessor /
 * zcodeTaskListTypes / broadcast 消费面）
 *
 * 本仓 web 端未接 zcode 的 subagents RPC/文件系统服务层，故只保留照搬 store
 * （store/subagentsStore.ts、store/subagentsContextStore.ts）所需的类型形状。
 * 运行时没有任何实现会注入：initialize/refresh 收不到服务实例时 store 落
 * error 态、agents 恒为空数组，UI 自动降级为默认配色/空列表。
 * 适配注记：P5 追加 `IServiceAccessor`（类型切片，成员按消费面收窄）、任务列表查询类型与
 * `BroadcastClaimLease`——composer 照搬件（remoteWorkspaceSessionStore / taskQueryCache /
 * codingPlanQuotaResetState stub）的类型消费面。
 */
import type {
  AgentSummary,
  AgentsCapability,
  SubAgentConfig,
  WorkspacePurpose,
  ZCodeProvider,
} from "@zui/lib/zcode-shared";

/** 与 zcode ISubagentsService.list 同形状；仅保留 store 消费的入参与返回。 */
export interface ISubagentsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string | undefined;
    provider: ZCodeProvider;
  }): Promise<{ agents: AgentSummary[]; capability: AgentsCapability | null }>;
  setEnabled(params: { agentId: string; enabled: boolean }): Promise<unknown>;
  createAgent(params: {
    config: SubAgentConfig;
    provider: ZCodeProvider;
  }): Promise<{ agent: AgentSummary | null }>;
  updateAgent(params: {
    agentId: string;
    config: SubAgentConfig;
    oldFilePath?: string | undefined;
    provider: ZCodeProvider;
  }): Promise<{ agent: AgentSummary | null }>;
  deleteAgent(params: { agentId: string; filePath: string }): Promise<unknown>;
}

/* ---------- zcodeTaskListTypes.ts（P5 补充，照搬类型声明） ---------- */

export type ZCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type ZCodeTaskListSortBy = "created" | "updated";

export interface ZCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

/* ---------- broadcast.ts（P5 补充，照搬类型声明） ---------- */

export interface BroadcastClaimLease {
  key: string;
  token: string;
}

/* ---------- accessor.ts（P5 补充：IServiceAccessor 类型切片） ---------- */

/**
 * zcode IServiceAccessor 的宿主切片：本仓无 RPC 服务层，仅保留照搬件实际以类型位消费的
 * 成员（其余成员照搬件不触达）。运行时实例恒由 hooks/useWorkspaceServices 的 stub 提供
 * （成员访问即「未接通」错误，UI 自动降级），无真实实现可注入。
 */
export interface IServiceAccessor {
  readonly [serviceId: string]: unknown;
}

/** 与 zcode ISubagentsService.list 同形状；仅保留 store 消费的入参与返回。 */
export interface ISubagentsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string | undefined;
    provider: ZCodeProvider;
  }): Promise<{ agents: AgentSummary[]; capability: AgentsCapability | null }>;
  setEnabled(params: { agentId: string; enabled: boolean }): Promise<unknown>;
  createAgent(params: {
    config: SubAgentConfig;
    provider: ZCodeProvider;
  }): Promise<{ agent: AgentSummary | null }>;
  updateAgent(params: {
    agentId: string;
    config: SubAgentConfig;
    oldFilePath?: string | undefined;
    provider: ZCodeProvider;
  }): Promise<{ agent: AgentSummary | null }>;
  deleteAgent(params: { agentId: string; filePath: string }): Promise<unknown>;
}
