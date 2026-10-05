/** 产品只保存adapter自有的opaque key，不接受LangGraph配置或凭据。 */
export interface AgentContextHistoryReference {
  adapter: string;
  key: string;
}
export interface AgentContextBranchCloneInput {
  sourceThreadId: string;
  targetThreadId: string;
  reference: AgentContextHistoryReference | null;
}
export interface AgentContextBranchTargetInput {
  targetThreadId: string;
  reference: AgentContextHistoryReference | null;
}
/** 可信消费者提供owned轮次引用；adapter保留完整原生状态，产品不解码opaque key。 */
export interface AgentContextBranchService {
  clone(
    input: AgentContextBranchCloneInput,
  ): Promise<AgentContextHistoryReference | null>;
  /** 只能清理本provider本次创建、尚未发布且引用匹配的目标。 */
  discard(input: AgentContextBranchTargetInput): Promise<void>;
  /** 产品事务发布成功后撤销该目标的清理所有权。 */
  release(input: AgentContextBranchTargetInput): void;
}
export interface AgentContextMessage {
  id: string | null;
  type: string;
  content: unknown;
  summary: boolean;
}
export interface AgentOperationUsage {
  modelCallId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}
export type AgentCompactResult =
  | { status: "applied"; reference: AgentContextHistoryReference }
  | {
      status: "unchanged";
      reference: AgentContextHistoryReference | null;
      reason: "insufficient_history";
    };
export interface AgentContextHistory {
  compactCurrent(input: {
    threadId: string;
    signal?: AbortSignal;
    onUsage?: (usage: AgentOperationUsage) => void;
  }): Promise<AgentCompactResult>;
  /** null仅表示本thread尚未有实际checkpoint；读取失败必须抛错。 */
  captureCurrentReference(
    threadId: string,
  ): Promise<AgentContextHistoryReference | null>;
  getEffectiveState(
    reference: AgentContextHistoryReference,
  ): Promise<{ messages: AgentContextMessage[] }>;
}
