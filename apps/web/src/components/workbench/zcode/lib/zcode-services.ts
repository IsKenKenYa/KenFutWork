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
  GitBranchMutationResult,
  GitCommitMessageConversationContext,
  GitCommitResult,
  GitFileChange,
  GitGenerateCommitMessageResult,
  GitIdentity,
  GitLocalBranchListResult,
  GitPushResult,
  GitRefreshResult,
  Locale,
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

/* ---------- git.ts（P6 补充：IGitService 类型切片） ---------- */

/**
 * zcode IGitService 的宿主切片：本仓 git 数据/操作走宿主自己的服务端 API
 * （apps/web/src/lib/code-git-api.ts），不经 zcode RPC。此处仅保留照搬组件
 * （GitActionMenu / git-branch-switcher/switchAssist / hooks/useGitRepository 等）
 * 以类型位消费的方法签名；运行时注入的是「未接通」stub（见 hooks/useServices），
 * 纯展示逻辑（props 驱动）不受影响，写操作抛错即能力缺失、UI 降级。
 */
export interface IGitService {
  refresh(params: {
    workspacePath: string;
    includeIdentity?: boolean | undefined;
    includeBranchComparison?: boolean | undefined;
  }): Promise<GitRefreshResult>;
  getChanges(params: {
    workspacePath: string;
    sourceId: "unstaged" | "staged";
  }): Promise<GitFileChange[]>;
  getIdentity(params: { workspacePath: string }): Promise<GitIdentity | null>;
  getLocalBranches(params: {
    workspacePath: string;
  }): Promise<GitLocalBranchListResult>;
  switchBranch(params: {
    workspacePath: string;
    targetBranchName: string;
  }): Promise<GitBranchMutationResult>;
  createBranchAndSwitch(params: {
    workspacePath: string;
    branchName: string;
    startPoint?: string | undefined;
  }): Promise<GitBranchMutationResult>;
  stagePaths(params: {
    workspacePath: string;
    paths: string[];
  }): Promise<unknown>;
  discardPaths(params: {
    workspacePath: string;
    paths: string[];
    staged?: boolean | undefined;
  }): Promise<unknown>;
  commit(params: {
    workspacePath: string;
    message: string;
    paths?: string[] | undefined;
    stagedOnly?: boolean | undefined;
  }): Promise<GitCommitResult>;
  generateCommitMessage(params: {
    workspacePath: string;
    workspaceIdentity?: string | undefined;
    locale?: Locale | undefined;
    includeUnstaged?: boolean | undefined;
    currentSessionFilePaths?: string[] | undefined;
    conversationContext?: GitCommitMessageConversationContext | undefined;
  }): Promise<GitGenerateCommitMessageResult>;
  push(params: { workspacePath: string }): Promise<GitPushResult>;
}
