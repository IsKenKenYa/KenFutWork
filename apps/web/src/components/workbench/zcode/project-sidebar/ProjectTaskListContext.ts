import { createContext } from "react";
import type { ProjectTask } from "@zui/project-sidebar/contract.js";

/** 列表展示配置只来自侧栏 owner；不承载 Host 行集合或会话运行态。 */
export const ProjectTaskListContext = createContext<{
  isWebRemoteControl?: boolean;
  activeWorkspaceKey?: string;
  mobileActiveTaskKey?: string | null;
  onOpenTaskFiles?: (task: ProjectTask, remoteSessionId?: string) => Promise<void>;
  onRenameTask?: (task: ProjectTask, title: string) => Promise<unknown>;
  onArchiveTask?: (task: ProjectTask) => Promise<unknown>;
  onMarkTaskAsUnread?: (task: ProjectTask) => Promise<unknown>;
  onPin?: (task: ProjectTask, pinned: boolean, commit: () => Promise<unknown>) => Promise<void>;
}>({});
