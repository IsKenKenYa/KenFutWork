import type { ProjectTask as ServiceProjectTask } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";

export type ProjectTask = ServiceProjectTask & ZCodeTaskMeta;
export type ProjectTaskRef = Pick<ProjectTask, "workspacePath" | "workspaceIdentity" | "taskId" | "taskControl">;
export interface ProjectSidebarProps {
  onSelectTask: (
    path: string,
    taskId: string,
    workspaceIdentity?: string,
    remoteSessionId?: string,
    expectedUnreadAt?: number,
  ) => void;
}
export type {
  ProjectTree,
  VirtualProject,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  IZCodeTaskService,
  IWindowControllerService,
  WindowHostControllerMutation,
} from "@zcode/services";
export type { WindowHostTaskAddress } from "@zcode/shared/zcode-protocol-v4";
