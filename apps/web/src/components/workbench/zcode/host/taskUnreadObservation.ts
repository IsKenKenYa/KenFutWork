import type { ZCodeTaskMeta, ZCodeTaskUnreadObservation } from "@zcode/shared";
import { conversationTaskControlSchema } from "@zcode/shared/zcode-protocol-v4";

type TaskUnreadSnapshot = Pick<ZCodeTaskMeta, "taskControl" | "lastUnreadAt">;

/** 点击时只固定当前行的观察，后续导航和请求复用这一份值。 */
export function captureTaskUnreadObservation(
  task: TaskUnreadSnapshot,
): ZCodeTaskUnreadObservation | undefined {
  const control = conversationTaskControlSchema.safeParse(task.taskControl);
  const lastUnreadAt = task.lastUnreadAt;
  if (
    !control.success ||
    typeof lastUnreadAt !== "number" ||
    !Number.isSafeInteger(lastUnreadAt) ||
    lastUnreadAt < 0
  )
    return undefined;
  return Object.freeze({
    taskControl: Object.freeze(structuredClone(control.data)),
    observedLastUnreadAt: lastUnreadAt,
  });
}

export function requireTaskUnreadObservation(
  task: TaskUnreadSnapshot,
): ZCodeTaskUnreadObservation {
  const observation = captureTaskUnreadObservation(task);
  if (!observation) throw new Error("任务状态已改变，请刷新后重试。");
  return observation;
}
