import type { HostNewTaskRequest } from "@kenfutwork/shared";

/**
 * 管理文档（独立 iframe）发起的创建任务：父页经 postMessage 转给 Code 壳，
 * 壳内落到 Root 的新任务入口（草稿、执行方式与 workspace 隔离保持单一路径）。
 */
export const HOST_NEW_TASK_EVENT = "kenfutwork:host-new-task";

export type HostNewTaskDetail = Omit<HostNewTaskRequest, "type">;

export function dispatchHostNewTask(detail: HostNewTaskDetail) {
  window.dispatchEvent(
    new CustomEvent<HostNewTaskDetail>(HOST_NEW_TASK_EVENT, { detail }),
  );
}
