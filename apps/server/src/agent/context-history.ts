/** 产品只保存adapter自有的opaque key，不接受LangGraph配置或凭据。 */
export interface AgentContextHistoryReference {
  adapter: string;
  key: string;
}
export interface AgentContextMessage {
  id: string | null;
  type: string;
  content: unknown;
  summary: boolean;
}
export interface AgentOperationUsage {
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
