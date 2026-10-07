import { z } from "zod";
import type { ToolDefinition } from "../../kernel/types.js";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  askUserQuestionInputSchema,
  projectAskUserQuestionInput,
} from "./user-input-schema.js";
import type { CodeUserInputService } from "./user-input-types.js";

/** 问题协议沿固定ZCode契约；实际答案消费由同一kernel broker完成。 */
export function createAskUserQuestionToolDefinition(options: {
  broker: CodeUserInputService;
}): ToolDefinition {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    scope: "code",
    access: "read",
    exposure: "core",
    description:
      "Ask the user structured clarification questions only when a user-owned decision blocks progress. Inspect the request and code first; use sensible defaults for routine choices. Put a recommended choice first and suffix its label with (Recommended). The client provides Other and custom text. Empty or partial answers do not authorize invented preferences: continue with the supplied answers and use best judgment for unanswered questions.",
    // Zod4的output投影将defaulted multiSelect列为required；运行时仍允许省略。
    parameters: z.toJSONSchema(askUserQuestionInputSchema, { io: "output" }),
    zodSchema: askUserQuestionInputSchema,
    projectArguments: (args) =>
      projectAskUserQuestionInput(askUserQuestionInputSchema.parse(args)),
    execute: async (args, context) => {
      const invocation = context.permissionInvocation;
      const signal = context.signal;
      const scope = context.scopeHandle?.describe();
      if (
        !invocation ||
        !signal ||
        !context.scopeHandle ||
        !context.runId ||
        !context.toolCallId ||
        invocation.instanceId !== scope?.instanceId ||
        invocation.taskId !== scope?.taskId ||
        invocation.scopeGeneration !== scope?.generation ||
        invocation.runId !== context.runId ||
        invocation.toolCallId !== context.toolCallId ||
        invocation.agentId !== context.scopeHandle.agentId ||
        invocation.role !== context.scopeHandle.role
      )
        throw new Error("AskUserQuestion必须绑定真实Code工具调用与取消信号。");
      const input = askUserQuestionInputSchema.parse(args);
      if (
        parameterFingerprint(input) !==
        parameterFingerprint(askUserQuestionInputSchema.parse(invocation.args))
      )
        throw new Error("AskUserQuestion的执行参数与可信调用绑定不匹配。");
      const result = await options.broker.request({ ...invocation, signal });
      signal.throwIfAborted();
      return result;
    },
  };
}
