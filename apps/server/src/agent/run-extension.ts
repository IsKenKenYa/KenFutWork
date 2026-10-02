import type { AgentMiddleware } from "langchain";

export type AgentEventIdentity = { agentCallId?: string; agentName?: string };

/** 插件贡献的 SDK middleware 缝；运行时只按 preset 消费，不认业务插件名。 */
export interface AgentRunExtension {
  preset: "code" | "design";
  canonicalToolEvents?: boolean;
  createMiddleware(identity: AgentEventIdentity): AgentMiddleware;
}
