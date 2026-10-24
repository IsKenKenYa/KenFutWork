import {
  type CodeTaskPinObservation,
  codeTaskPinArgsSchema,
  codeTaskPinControllerArgsSchema,
  codeTaskPinMetaSchema,
} from "@kenfutwork/shared";
import { assertTaskOperationResult } from "./taskOperationObservation.js";

interface TaskPinCall {
  args: unknown[];
  target: CodeTaskPinObservation;
  pinned: boolean;
}

/** 在等待连接前复制原置顶意图，不补充当前缓存中的观察。 */
export function captureTaskPinCall(
  service: string,
  method: string,
  args: unknown,
): TaskPinCall | undefined {
  if (service === "zcode-task" && method === "setTaskPinned") {
    const parsed = codeTaskPinArgsSchema.parse(args);
    return { args: parsed, target: parsed[0], pinned: parsed[0].pinned };
  }
  if (service !== "window-controller" || method !== "mutateTask")
    return undefined;
  const first = Array.isArray(args) ? args[0] : undefined;
  if (!first || typeof first !== "object" || !("mutation" in first))
    return undefined;
  const mutation = first.mutation;
  if (
    !mutation ||
    typeof mutation !== "object" ||
    !("kind" in mutation) ||
    mutation.kind !== "pin"
  )
    return undefined;
  const parsed = codeTaskPinControllerArgsSchema.parse(args);
  return {
    args: parsed,
    target: parsed[0].address,
    pinned: parsed[0].mutation.pinned,
  };
}

export function readTaskPinResult(call: TaskPinCall, value: unknown) {
  const meta = codeTaskPinMetaSchema.parse(value);
  assertTaskOperationResult(call.target, meta);
  if (
    meta.pinned !== call.pinned ||
    meta.pinRevision < call.target.observedPinRevision
  )
    throw new Error("任务回执已改变，请重新加载列表。");
  return meta;
}
