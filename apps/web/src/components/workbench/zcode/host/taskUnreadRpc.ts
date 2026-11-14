import {
  type CodeTaskUnreadObservation,
  codeTaskUnreadArgsSchema,
  codeTaskUnreadControllerArgsSchema,
  codeTaskUnreadMetaSchema,
} from "@kenfutwork/shared";
import { assertTaskOperationResult } from "./taskOperationObservation.js";

interface TaskUnreadCall {
  args: unknown[];
  target: CodeTaskUnreadObservation;
}

/** 在连接等待前解析并复制原意图，后续只发送这份参数。 */
export function captureTaskUnreadCall(
  service: string,
  method: string,
  args: unknown,
): TaskUnreadCall | undefined {
  if (service === "zcode-task" && method === "setTaskUnread") {
    const parsed = codeTaskUnreadArgsSchema.parse(args);
    return { args: parsed, target: parsed[0] };
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
    (mutation.kind !== "mark-read" && mutation.kind !== "mark-unread")
  )
    return undefined;
  const parsed = codeTaskUnreadControllerArgsSchema.parse(args);
  return { args: parsed, target: parsed[0].address };
}

/** 回执只确认原 Task 的操作，未读显示仍由当前权威列表提供。 */
export function readTaskUnreadResult(call: TaskUnreadCall, value: unknown) {
  const meta = codeTaskUnreadMetaSchema.parse(value);
  assertTaskOperationResult(call.target, meta);
  return meta;
}
