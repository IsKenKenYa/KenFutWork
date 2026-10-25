import type {
  CodeTaskOrganizationTarget,
  codeTaskUnreadMetaSchema,
} from "@kenfutwork/shared";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { conversationTaskControlSchema } from "@zcode/shared/zcode-protocol-v4";
import { buildTaskEntityKey } from "@zui/lib/taskQueryCache.js";
import type { z } from "zod";

/** 操作只使用原行中的有效版本，并复制该次 Task 控制身份。 */
export function captureTaskRevisionObservation(
  control: unknown,
  revision: unknown,
) {
  const parsed = conversationTaskControlSchema.safeParse(control);
  if (
    !parsed.success ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    return undefined;
  return Object.freeze({
    taskControl: Object.freeze(structuredClone(parsed.data)),
    revision,
  });
}

export function resolveTaskOperationSnapshot(
  target: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  tasks: readonly ZCodeTaskMeta[],
  activeTask: ZCodeTaskMeta | null,
) {
  const key = buildTaskEntityKey(target);
  return (
    tasks.find((task) => buildTaskEntityKey(task) === key) ??
    (activeTask && buildTaskEntityKey(activeTask) === key
      ? activeTask
      : undefined)
  );
}

/** 回执只确认原操作的来源；当前列表仍独立读取。 */
export function assertTaskOperationResult(
  target: CodeTaskOrganizationTarget,
  meta: Pick<
    z.infer<typeof codeTaskUnreadMetaSchema>,
    | "taskId"
    | "workspacePath"
    | "workspaceIdentity"
    | "projectId"
    | "taskControl"
  >,
) {
  if (
    meta.taskId !== target.taskId ||
    meta.workspacePath !== target.workspacePath ||
    meta.workspaceIdentity !== target.workspaceIdentity ||
    meta.projectId !== target.taskControl.projectId ||
    meta.taskControl?.projectId !== target.taskControl.projectId ||
    meta.taskControl?.branchGeneration !== target.taskControl.branchGeneration
  )
    throw new Error("任务回执已改变，请重新加载列表。");
}
