import { isLocalWorkspaceTarget, type ZCodeTaskPinObservation, type ZCodeTaskUnreadObservation } from "@zcode/shared";
import { requireTaskPinObservation } from "@zui/host/taskPinObservation.js";
import { requireTaskUnreadObservation } from "@zui/host/taskUnreadObservation.js";
import type {
  ProjectTaskRef,
  IZCodeTaskService,
  IWindowControllerService,
  WindowHostControllerMutation,
  WindowHostTaskAddress,
} from "@zui/project-sidebar/contract.js";
export type ProjectTaskMutation = Extract<
  WindowHostControllerMutation,
  { kind: "archive" | "delete" | "pin" | "mark-read" | "mark-unread" }
> | { kind: "rename"; title: string };
interface ProjectTaskPorts {
  service: IZCodeTaskService;
  controller?: IWindowControllerService;
}
type TaskMutationObservation = ZCodeTaskUnreadObservation | ZCodeTaskPinObservation;
function taskAddress(
  task: ProjectTaskRef,
  remoteSessionId?: string | null,
  observation?: TaskMutationObservation,
): WindowHostTaskAddress & Partial<ZCodeTaskUnreadObservation & ZCodeTaskPinObservation> {
  return {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    ...(task.taskControl ? { taskControl: structuredClone(task.taskControl) } : {}),
    ...observation,
    ...(remoteSessionId ? { remoteSessionId } : {}),
  };
}
/** 已查看事件读取唯一 owner 的 marker；不借用 UI 行缓存，也不跨 Source 使用本机服务。 */
export function readProjectTaskMeta(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  _remoteSessionId?: string,
) {
  return ports.service.getTaskMeta(task);
}
/** 两个列表入口共用完整地址与命令路由；组织态和 CLI 事实仍各自只由原 owner 写入。 */
export async function mutateProjectTask(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  mutation: ProjectTaskMutation,
  remoteSessionId?: string | null,
) {
  const local = isLocalWorkspaceTarget({ ...task, remoteSessionId });
  const observation = local && mutation.kind === "pin"
    ? requireTaskPinObservation(task)
    : local && (mutation.kind === "mark-read" || mutation.kind === "mark-unread")
      ? requireTaskUnreadObservation(task)
      : undefined;
  const target = {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    ...(task.taskControl ? { taskControl: structuredClone(task.taskControl) } : {}),
    ...observation,
  };
  if (ports.controller && mutation.kind !== "archive" && mutation.kind !== "delete" && mutation.kind !== "rename")
    return ports.controller.mutateTask({
      address: taskAddress(target, remoteSessionId, observation),
      mutation,
    });
  switch (mutation.kind) {
    case "archive":
      if (!target.taskControl) throw new Error("任务已改变，请刷新后重试。");
      return mutation.archived
        ? ports.service.archiveTask(target)
        : ports.service.unarchiveTask(target);
    case "delete":
      await ports.service.deleteTask(target);
      return null;
    case "rename":
      return ports.service.renameTask({ ...target, title: mutation.title });
    case "pin":
      return ports.service.setTaskPinned({ ...target, pinned: mutation.pinned });
    case "mark-read":
      return ports.service.setTaskUnread({
        ...target,
        unread: false,
        expectedUnreadAt: mutation.expectedUnreadAt,
      });
    case "mark-unread":
      return ports.service.setTaskUnread({ ...target, unread: true });
  }
}
