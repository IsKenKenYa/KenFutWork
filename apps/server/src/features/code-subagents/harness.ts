import { randomUUID } from "node:crypto";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import type { AgentRunService } from "../../agent/runtime.js";
import type { AgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import type {
  CodeChildRequest,
  CodeChildResult,
  CodeChildSessions,
} from "./types.js";

/** 子运行使用同一 AgentRunService/factory；本模块不创建第二条模型循环。 */
export function createCodeChildHarness(deps: {
  runs: AgentRunService;
  metadata: AgentRunMetadataService;
  sessions: CodeChildSessions;
}) {
  const executeChild = async (
    request: CodeChildRequest,
    signal: AbortSignal,
  ): Promise<CodeChildResult> => {
    signal.throwIfAborted();
    const child = await deps.sessions.open(request);
    const runId = randomUUID();
    const scope = request.scope.derive(request.role, child.sessionId);
    const instructions = `角色：${request.role}。${request.role === "worker" ? "在继承权限上限内完成实现。" : "只读分析，不修改文件或通过审批扩大权限。"}\n负责路径：${request.ownership.join("、")}\n完成标准：${request.completionCriteria}\n任务：${request.description}\n你不是独自在代码库，不撤销他人的改动。返回结果、关键路径和验证证据；跟随用户任务的语言。`;
    await deps.metadata.createAcceptedRun({
      runId,
      sessionId: child.sessionId,
      threadId: child.threadId,
      model: request.model,
    });
    deps.runs.createRun(
      {
        sessionId: child.sessionId,
        conversationId: child.sessionId,
        projectId: scope.describe().projectId,
        taskId: scope.describe().taskId,
        preset: "code",
        prompt: instructions,
        model: request.model,
      },
      {
        runId,
        threadId: child.threadId,
        scopeHandle: scope,
        actor: request.actor,
        model: request.model,
        delegationDepth: request.delegationDepth + 1,
        roleInstructions: instructions,
        approvalCeiling: request.approvalCeiling,
        eventSink: child.emit,
      },
    );
    const cancel = () => {
      deps.runs.cancelRun(runId);
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    let text = "";
    let status: CodeChildResult["status"] = "failed";
    let failure = "子运行没有返回终态";
    try {
      for await (const event of deps.runs.streamRun(runId)) {
        if (event.type === "message.delta") text += event.delta;
        if (event.type === "run.completed") status = "completed";
        if (event.type === "run.canceled") status = "canceled";
        if (event.type === "run.failed") {
          status = "failed";
          failure = event.error.message;
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    const summary =
      status === "completed"
        ? text || "子运行完成，未返回正文"
        : status === "canceled"
          ? "子运行已停止"
          : failure;
    const output = await child.storeResult(summary);
    return {
      status,
      summary,
      outputRef: output.path,
      outputStats: output.stats,
      childSessionId: child.sessionId,
      childRunId: runId,
    };
  };
  // 独立子图不继承父Pregel内部abort/namespace/callback通道；归因仍由request/eventSink持有。
  return (request: CodeChildRequest, signal: AbortSignal) =>
    AsyncLocalStorageProviderSingleton.runWithConfig(
      {},
      () => executeChild(request, signal),
      true,
    );
}
