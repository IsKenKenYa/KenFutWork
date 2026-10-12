import type { WsCommand } from "@kenfutwork/shared";
import type { ThreadService } from "../features/chat/thread-service.js";
import type { DesignRunHost } from "../features/execution/design-run-host-types.js";
import { DesignTaskError } from "../features/execution/design-task-errors.js";
import type { DesignTasksService } from "../features/execution/design-task-types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import type { ConnectionManager } from "./connection-manager.js";
import type { CanvasEventBuffer } from "./event-buffer.js";

type RunPayload = Extract<WsCommand, { action: "agent.run" }>["payload"];
type Slot = {
  actor: LocalActor;
  scope?: string;
  taskId?: string;
  lastSeq: number;
  gates: number;
};
export const designTaskEventKey = (instanceId: string, taskId: string) =>
  `design-task:${instanceId}:${taskId}`;
/** One host listener; sockets only subscribe and replay already-owned Run events. */
export function createDesignTransport(deps: {
  host: Pick<DesignRunHost, "submit" | "stop" | "onEvent">;
  tasks: Pick<DesignTasksService, "readPolicy">;
  threads: Pick<ThreadService, "resolveOwnedSessionThread">;
  connections: Pick<ConnectionManager, "sendTo">;
  buffer: CanvasEventBuffer;
}) {
  const slots = new Map<string, Slot>();
  const flush = (connectionId: string, slot: Slot) => {
    if (slot.gates || !slot.scope || slots.get(connectionId) !== slot) return;
    for (const entry of deps.buffer.getAfter(slot.scope, slot.lastSeq)) {
      deps.connections.sendTo(connectionId, {
        type: "event",
        event: entry.event,
        seq: entry.seq,
        ...(slot.taskId ? { taskId: slot.taskId } : {}),
      });
      slot.lastSeq = entry.seq;
    }
  };
  const unsubscribe = deps.host.onEvent((message) => {
    const key = designTaskEventKey(message.instanceId, message.taskId);
    deps.buffer.push(key, message.event);
    for (const [connectionId, slot] of slots)
      if (slot.scope === key) flush(connectionId, slot);
  });
  const slotFor = (connectionId: string, actor: LocalActor) => {
    const slot = slots.get(connectionId);
    if (
      !slot ||
      slot.actor.instanceId !== actor.instanceId ||
      slot.actor.accessClientId !== actor.accessClientId
    )
      throw new DesignTaskError(
        "design_connection_changed",
        "本机连接已改变，请重新连接",
        409,
      );
    return slot;
  };
  return {
    connect(connectionId: string, actor: LocalActor) {
      const slot: Slot = { actor, lastSeq: 0, gates: 0 };
      slots.set(connectionId, slot);
      return () => {
        if (slots.get(connectionId) === slot) slots.delete(connectionId);
      };
    },
    gate(connectionId: string) {
      const slot = slots.get(connectionId);
      if (!slot) return () => {};
      slot.gates++;
      return () => {
        slot.gates = Math.max(0, slot.gates - 1);
        flush(connectionId, slot);
      };
    },
    async run(
      actor: LocalActor,
      connectionId: string,
      payload: RunPayload,
      requestId?: string,
    ) {
      const slot = slotFor(connectionId, actor);
      if (
        payload.taskId !== payload.sessionId ||
        !payload.inputId ||
        !payload.scopeGeneration ||
        !payload.branchGeneration
      )
        throw new DesignTaskError(
          "design_task_admission_required",
          "Design请求需要真实Task、输入编号与授权代际",
          400,
        );
      const {
        inputId,
        scopeGeneration,
        branchGeneration,
        accessToken: _token,
        ...request
      } = payload;
      const policy = await deps.tasks.readPolicy(actor, payload.taskId);
      if (
        policy.scopeGeneration !== scopeGeneration ||
        policy.branchGeneration !== branchGeneration
      )
        throw new DesignTaskError(
          "design_task_policy_changed",
          "任务权限已改变，请重新加载",
        );
      if (payload.executionMode === "loop")
        throw new DesignTaskError(
          "design_mode_unsupported",
          "循环模式已停用，请使用目标模式",
          400,
        );
      if (policy.executionState !== "ready")
        throw new DesignTaskError("design_task_busy", "任务暂不能接收输入");
      if (
        payload.executionMode &&
        payload.executionMode !== "goal" &&
        (payload.executionMode === "plan") !== policy.planEnabled
      )
        throw new DesignTaskError(
          "design_plan_update_required",
          "请先更新任务计划状态，再发送",
          409,
        );
      const key = designTaskEventKey(actor.instanceId, payload.taskId);
      const baseline =
        slot.scope === key ? slot.lastSeq : deps.buffer.getLatestSeq(key);
      const admitted = await deps.host.submit(actor, {
        taskId: payload.taskId,
        inputId,
        scopeGeneration: policy.scopeGeneration,
        branchGeneration: policy.branchGeneration,
        request,
      });
      deps.connections.sendTo(connectionId, {
        type: "command.ack",
        action: "agent.run",
        ...(requestId ? { requestId } : {}),
        payload: {
          runId: admitted.runId,
          sessionId: payload.taskId,
          taskId: payload.taskId,
          inputId,
          delivery: admitted.kind,
          activeRunId: (await deps.tasks.readPolicy(actor, payload.taskId))
            .activeRunId,
          latestSeq: deps.buffer.getLatestSeq(key),
          scopeGeneration: policy.scopeGeneration,
          branchGeneration: policy.branchGeneration,
        },
      });
      slot.lastSeq =
        admitted.kind === "duplicate" && slot.scope !== key ? 0 : baseline;
      slot.scope = key;
      slot.taskId = payload.taskId;
      flush(connectionId, slot);
    },
    async cancel(
      actor: LocalActor,
      connectionId: string,
      taskId: string,
      runId: string,
      requestId?: string,
    ) {
      const binding = await deps.threads.resolveOwnedSessionThread(
        actor,
        taskId,
      );
      if (binding.mode !== "design")
        throw new DesignTaskError(
          "design_task_identity_mismatch",
          "取消目标不是Design Task",
        );
      const result = await deps.host.stop(actor, {
        taskId,
        expectedRunId: runId,
      });
      deps.connections.sendTo(connectionId, {
        type: "command.ack",
        action: "agent.cancel",
        ...(requestId ? { requestId } : {}),
        payload: { taskId, runId, status: result.kind },
      });
    },
    async resume(
      actor: LocalActor,
      connectionId: string,
      taskId: string,
      lastSeq: number,
      requestId?: string,
    ) {
      const slot = slotFor(connectionId, actor);
      const binding = await deps.threads.resolveOwnedSessionThread(
        actor,
        taskId,
      );
      if (binding.mode !== "design" || !binding.canvasId)
        throw new DesignTaskError(
          "design_task_identity_mismatch",
          "续接目标不是Design Task",
        );
      const policy = await deps.tasks.readPolicy(actor, taskId);
      const key = designTaskEventKey(actor.instanceId, taskId);
      const latestSeq = deps.buffer.getLatestSeq(key);
      const afterSeq = lastSeq > latestSeq ? 0 : lastSeq;
      const missed = deps.buffer.getAfter(key, afterSeq);
      const replayGap =
        lastSeq > latestSeq ||
        (missed.length > 0 && missed[0]!.seq > afterSeq + 1);
      deps.connections.sendTo(connectionId, {
        type: "command.ack",
        action: "task.resume",
        ...(requestId ? { requestId } : {}),
        payload: {
          taskId,
          canvasId: binding.canvasId,
          activeRunId: policy.activeRunId,
          latestSeq,
          replayed: missed.length,
          replayGap,
          scopeGeneration: policy.scopeGeneration,
          branchGeneration: policy.branchGeneration,
        },
      });
      slot.scope = key;
      slot.taskId = taskId;
      slot.lastSeq = afterSeq;
      flush(connectionId, slot);
    },
    close() {
      unsubscribe();
      slots.clear();
    },
  };
}
export type DesignTransport = ReturnType<typeof createDesignTransport>;
