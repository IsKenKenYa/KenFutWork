import type { AgentMiddleware } from "langchain";
import type {
  PromptCompositionContext,
  RunToolResolutionContext,
  SystemPromptRegistry,
  ToolExecutionContext,
  ToolRegistry,
} from "../kernel/types.js";

export type AgentEventIdentity = { agentCallId?: string; agentName?: string };
export interface AgentRunExtensionContext {
  prompt?:
    | { registry: SystemPromptRegistry; composition: PromptCompositionContext }
    | undefined;
  registry: ToolRegistry;
  resolution: RunToolResolutionContext;
  execution: ToolExecutionContext;
}

/** 插件贡献的 SDK middleware 缝；运行时只按 preset 消费，不认业务插件名。 */
export interface AgentRunExtension {
  preset: "code" | "design";
  canonicalToolEvents?: boolean;
  createMiddleware(
    identity: AgentEventIdentity,
    context?: AgentRunExtensionContext,
  ): AgentMiddleware;
}
