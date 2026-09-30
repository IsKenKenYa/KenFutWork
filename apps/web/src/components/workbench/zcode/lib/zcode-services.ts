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
  /** zcode 照搬（P9 补充）：消费方（useModelSelectionView / useUsageEntitlement）按 optional 切片访问，stub 下得 undefined 判空降级。 */
  readonly modelSelectionService?: IModelSelectionService | undefined;
  readonly usageStatsService?: IUsageStatsService | undefined;
  /** zcode 照搬（P9 补充）：AssistantPreviewCards 校验消费面（AssistantPreviewCardFileStatService 切片），stub 下恒 undefined。 */
  readonly fileService?:
    | import("./assistantPreviewCards").AssistantPreviewCardFileStatService
    | undefined;
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

/* ---------- zcode 照搬（P9 补充）：services 服务缝类型切片 ----------
 * 来源：references/zcode/packages/services/src/model-provider/providerFacadeServices.ts、
 * references/zcode/packages/provider/src/facades.ts（View 类型）、rpc Event 形状。
 * 消费方：hooks/{useModelSelectionView,useProviderSettingsView}、lib/providerSettingsSnapshot、
 * lib/{modelSelectionGroups,modelThoughtOption,accountProviderAccess,codingPlanFunnelTelemetry}、
 * settings/CodingPlanUpgradeDialog、hooks/useCodingPlanEntryPlanList。许可证：Apache-2.0（zcode）。
 * 适配注记：类型切片与上游字段逐一对齐；View 主体在 lib/zcode-provider.ts（@zcode/provider 切片），
 * 此处 re-export 以保持消费方 `from "@zcode/services"` 的导入面。
 */

/** zcode rpc Event 的宿主切片：订阅返回可释放句柄。 */
export interface ZCodeEventSubscription {
  dispose(): void;
}

export type ZCodeServiceEvent<T> = (
  listener: (value: T) => void,
) => ZCodeEventSubscription;

export type {
  AccountProviderState,
  ConfigValidationIssue,
  ModelConfigObject,
  ModelId,
  ModelSelectionView,
  ModelSelectionViewInput,
  ProviderConfigObject,
  ProviderId,
  ProviderSettingsProviderView,
  ProviderSettingsView,
} from "@zui/lib/zcode-provider";

import type {
  ModelSelectionView,
  ModelSelectionViewInput,
  ProviderSettingsView,
} from "@zui/lib/zcode-provider";
import type {
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
} from "@zui/lib/zcode-shared";

/** 模型选择 Facade 的服务切片：消费方仅读 View 与变更事件（写入面本仓未接通）。 */
export interface IModelSelectionService {
  readonly onDidChange: ZCodeServiceEvent<ModelSelectionView>;
  getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView>;
}

/** Provider Settings Facade 的服务切片：消费方仅读 View 与变更事件（写入面本仓未接通）。 */
export interface IProviderSettingsService {
  readonly onDidChange: ZCodeServiceEvent<ProviderSettingsView>;
  getView(): Promise<ProviderSettingsView>;
}

/** Usage Stats Facade 的服务切片：本仓消费面 entitlement 读取 + coding-plan 重置机会查询（P9 补充；写面/其余查询未接通）。 */
export interface IUsageStatsService {
  getEntitlementSnapshot(
    request?: UsageEntitlementRequest,
  ): Promise<UsageEntitlementSnapshot>;
  /** zcode 照搬（P9 补充）：签名逐字取自 references/zcode/packages/services/src/usage-stats/usageStats.ts。 */
  requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult>;
}
