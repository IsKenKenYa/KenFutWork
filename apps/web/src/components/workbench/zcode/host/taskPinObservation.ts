import type { ZCodeTaskMeta, ZCodeTaskPinObservation } from "@zcode/shared";
import { captureTaskRevisionObservation } from "./taskOperationObservation.js";

type TaskPinSnapshot = Pick<ZCodeTaskMeta, "taskControl" | "pinRevision">;

export function captureTaskPinObservation(
  task: TaskPinSnapshot,
): ZCodeTaskPinObservation | undefined {
  const observation = captureTaskRevisionObservation(
    task.taskControl,
    task.pinRevision,
  );
  return observation
    ? Object.freeze({
        taskControl: observation.taskControl,
        observedPinRevision: observation.revision,
      })
    : undefined;
}

export function requireTaskPinObservation(
  task: TaskPinSnapshot,
): ZCodeTaskPinObservation {
  const observation = captureTaskPinObservation(task);
  if (!observation) throw new Error("任务状态已改变，请刷新后重试。");
  return observation;
}
