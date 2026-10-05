import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { AgentMiddleware } from "langchain";
import type {
  PromptCompositionContext,
  RunToolResolutionContext,
  SystemPromptRegistry,
  ToolExecutionContext,
  ToolRegistry,
} from "../kernel/types.js";
import type { ModelInvocationSnapshot } from "../providers/types.js";

export type AgentEventIdentity = { agentCallId?: string; agentName?: string };
/** 模型边界控制；选择由可信输入冻结，解析仍绑定当前Run的Actor/Scope。 */
export interface AgentRunModelControl {
  selectInvocation(invocation: ModelInvocationSnapshot): void;
  resolveCurrent(): Promise<BaseLanguageModel>;
}
export interface AgentRunExtensionContext {
  modelControl?: AgentRunModelControl;
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
