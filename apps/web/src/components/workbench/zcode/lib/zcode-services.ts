/**
 * zcode 宿主适配 stub：`@zcode/services` 的 `ISubagentsService` 最小类型等价。
 * 来源：references/zcode/packages/services（ISubagentsService 消费面）
 *
 * 本仓 web 端未接 zcode 的 subagents RPC/文件系统服务层，故只保留照搬 store
 * （store/subagentsStore.ts、store/subagentsContextStore.ts）所需的类型形状。
 * 运行时没有任何实现会注入：initialize/refresh 收不到服务实例时 store 落
 * error 态、agents 恒为空数组，UI 自动降级为默认配色/空列表。
 */
import type {
  AgentSummary,
  AgentsCapability,
  SubAgentConfig,
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
