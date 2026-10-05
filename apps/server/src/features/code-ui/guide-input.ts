import { createHash } from "node:crypto";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { createCodeUiConversation } from "./conversation.js";
import { codeGuideMessageId } from "./input-intents.js";
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";

function matchingRun(root: CodeUiSessionRecord, context: ToolExecutionContext) {
  const scope = context.scopeHandle?.describe();
  return (
    !!scope &&
    context.actor?.instanceId === scope.instanceId &&
    context.scopeHandle?.role === "main" &&
    context.scopeHandle.agentId === "main" &&
    root.active_run_id === context.runId &&
    root.state?.runId === context.runId &&
    root.execution_state === "ready" &&
    root.root_directory === scope.rootDirectory &&
    !root.archived &&
    !root.deleted_at &&
    Number(root.scope_generation) === scope.generation &&
    Number(root.branch_generation) === context.taskWorkContext?.branchGeneration
  );
}

function guidesForRun(root: CodeUiSessionRecord, runId: string) {
  return (root.state?.inputs ?? []).filter(
    (input) =>
      input.runId === runId &&
      input.intent.delivery.admitted === "guide" &&
      ["queued", "settled"].includes(input.status),
  );
}

/** Provider：同一Task事务持久提升指导；模型消费者用稳定消息ID防止重复注入。 */
export function createCodeGuideInputs(deps: {
  repository: CodeUiRepository;
  refresh(instanceId: string, path: string, projectId: string): Promise<void>;
}) {
  return {
    async hasPendingGuides(context: ToolExecutionContext) {
      const scope = context.scopeHandle?.describe();
      if (!scope || !context.runId) return false;
      context.signal?.throwIfAborted();
      const root = await deps.repository.find(scope.instanceId, scope.taskId);
      return (
        !!root &&
        matchingRun(root, context) &&
        guidesForRun(root, context.runId).some(
          (input) => input.status === "queued",
        )
      );
    },
    async consumeGuides(context: ToolExecutionContext) {
      const scope = context.scopeHandle?.describe();
      if (!scope || !context.runId) return [];
      context.signal?.throwIfAborted();
      let root = await deps.repository.find(scope.instanceId, scope.taskId);
      if (!root?.state || !matchingRun(root, context)) return [];
      const pending = guidesForRun(root, context.runId).filter(
        (input) => input.status === "queued",
      );
      if (pending.length) {
        const ids = new Set(pending.map(codeGuideMessageId));
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([...ids]))
          .digest("hex");
        await deps.repository.appendEvent(
          scope.instanceId,
          scope.taskId,
          {
            key: `guide-drain:${context.runId}/${fingerprint}`,
            fingerprint,
            event: {
              type: "guide.drained",
              runId: context.runId,
              messageIds: [...ids],
            },
          },
          (current) => {
            context.signal?.throwIfAborted();
            if (!current.state || !matchingRun(current, context))
              throw new Error("指导所属Run或Task代际已失效，未注入模型。");
            const snapshot = current.state.snapshots.find(
              (entry) => entry.sessionId === current.id,
            );
            if (!snapshot) throw new Error("指导所属根Task快照缺失。");
            const host = createCodeUiConversation({
              sessionId: current.id,
              workspacePath: scope.rootDirectory,
              config: snapshot.config,
              state: current.state,
            });
            host.consumeGuides(ids);
            return {
              state: host.exportState(),
              activeRunId: current.active_run_id,
            };
          },
        );
        await deps.refresh(
          scope.instanceId,
          scope.rootDirectory,
          root.project_id,
        );
        root = await deps.repository.find(scope.instanceId, scope.taskId);
      }
      context.signal?.throwIfAborted();
      if (!root || !matchingRun(root, context)) return [];
      // 已提升但graph尚未提交的消息仍可按相同ID补回；已有graph消息由consumer去重。
      return guidesForRun(root, context.runId)
        .filter((input) => input.intent.steer.state === "guided")
        .map((input) => ({
          id: codeGuideMessageId(input),
          text: input.intent.text,
        }));
    },
  };
}
