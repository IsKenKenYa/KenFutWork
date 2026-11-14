import type { ZCodeTaskMeta, ZCodeTaskUnreadObservation } from "@zcode/shared";
import { captureTaskRevisionObservation } from "./taskOperationObservation.js";

type TaskUnreadSnapshot = Pick<ZCodeTaskMeta, "taskControl" | "lastUnreadAt">;

/** 点击时只固定当前行的观察，后续导航和请求复用这一份值。 */
export function captureTaskUnreadObservation(
  task: TaskUnreadSnapshot,
): ZCodeTaskUnreadObservation | undefined {
  const observation = captureTaskRevisionObservation(
    task.taskControl,
    task.lastUnreadAt,
  );
  return observation
    ? Object.freeze({
        taskControl: observation.taskControl,
        observedLastUnreadAt: observation.revision,
      })
    : undefined;
}

export function requireTaskUnreadObservation(
  task: TaskUnreadSnapshot,
): ZCodeTaskUnreadObservation {
  const observation = captureTaskUnreadObservation(task);
  if (!observation) throw new Error("任务状态已改变，请刷新后重试。");
  return observation;
}
