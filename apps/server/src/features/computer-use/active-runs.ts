import { randomUUID } from "node:crypto";
import type {
  AgentRunExtension,
  AgentRunExtensionContext,
} from "../../agent/run-extension.js";
import { projectCanonicalToolEvent } from "../../agent/stream-adapter.js";
import { ToolDeniedError } from "../../kernel/context.js";
import { publicToolArguments } from "../../kernel/tool-arguments.js";
import type { ToolExecutionContext, ToolRegistry } from "../../kernel/types.js";
import type { LocalActor } from "../local-instance/types.js";
import type { CuToolResult } from "./service.js";
import { CU_TOOL_PREFIX } from "./tools.js";

interface ActiveRun {
  context: AgentRunExtensionContext;
  controller: AbortController;
}

/** 仅接收真实Agent扩展点提供的事实；HTTP路径/参数不能签发Task或复活结束的Run。 */
export function createActiveComputerUseRuns(registry: ToolRegistry) {
  const active = new Map<string, ActiveRun>();
  const closeRun = (runId: string) => {
    const entry = active.get(runId);
    active.delete(runId);
    entry?.controller.abort();
  };
  const requireRun = (actor: LocalActor, runId: string): ActiveRun => {
    const entry = active.get(runId);
    const execution = entry?.context.execution;
    if (
      !entry ||
      !execution?.actor ||
      execution.actor.instanceId !== actor.instanceId ||
      execution.scopeHandle?.role !== "main" ||
      execution.delegationDepth
    )
      throw new ToolDeniedError(
        "computer-use",
        "没有属于当前实例的活动主Code Run。",
      );
    execution.signal?.throwIfAborted();
    return entry;
  };
  const extension: AgentRunExtension = {
    preset: "code",
    createMiddleware(_identity, context) {
      return {
        name: "ComputerUseRunBinding",
        beforeAgent() {
          const execution = context?.execution;
          if (
            !context ||
            !execution?.runId ||
            !execution.actor ||
            !execution.signal ||
            !execution.publishToolEvent ||
            execution.scopeHandle?.role !== "main" ||
            execution.delegationDepth
          )
            return;
          execution.signal.throwIfAborted();
          closeRun(execution.runId);
          active.set(execution.runId, {
            context,
            controller: new AbortController(),
          });
        },
      };
    },
  };
  const resolveContext = (
    actor: LocalActor,
    runId: string,
    signal: AbortSignal,
  ): ToolExecutionContext => {
    const entry = requireRun(actor, runId);
    const execution = entry.context.execution;
    return {
      ...execution,
      toolCallId: `computer-use-mcp:${randomUUID()}`,
      signal: AbortSignal.any([
        entry.controller.signal,
        ...(execution.signal ? [execution.signal] : []),
        signal,
      ]),
    };
  };
  const execute = async (
    actor: LocalActor,
    runId: string,
    name: string,
    args: Record<string, unknown>,
    execution: ToolExecutionContext,
  ): Promise<CuToolResult> => {
    if (!name.startsWith(CU_TOOL_PREFIX))
      throw new ToolDeniedError(name, "此出口只允许桌面工具。");
    const entry = requireRun(actor, runId);
    const definition = registry.require(name);
    const identity = { toolName: name, toolCallId: execution.toolCallId };
    const emit = async (payload: Record<string, unknown>) => {
      if (active.get(runId) !== entry) return;
      const taskId = entry.context.execution.scopeHandle?.describe().taskId;
      if (!taskId || !entry.context.execution.publishToolEvent)
        throw new Error("活动Run未装配持久工具事件出口");
      for await (const event of projectCanonicalToolEvent(
        { ...identity, ...payload },
        { runId, sessionId: taskId, conversationId: taskId },
      ))
        await entry.context.execution.publishToolEvent(event);
    };
    await emit({
      phase: "started",
      input: publicToolArguments(definition, args),
    });
    try {
      const result = (await registry.execute(
        name,
        args,
        execution,
      )) as CuToolResult;
      await emit({
        phase: "completed",
        output: {
          ...(result.canonicalOutput ?? result),
          ...(result.display ? { display: result.display } : {}),
        },
      });
      return result;
    } catch (error) {
      await emit({
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof ToolDeniedError)
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
          structuredContent: {
            error: { code: "tool_denied", actionSent: false },
          },
        };
      throw error;
    }
  };
  return {
    extension,
    assertRun: (actor: LocalActor, runId: string) => {
      requireRun(actor, runId);
    },
    resolveContext,
    execute,
    closeRun,
    dispose: () => {
      for (const runId of active.keys()) closeRun(runId);
    },
  };
}
