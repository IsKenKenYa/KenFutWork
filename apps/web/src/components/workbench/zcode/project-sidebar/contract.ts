import type { CodeUiViewerScope } from "@kenfutwork/shared";
import type {
  ProjectTask as ServiceProjectTask,
  ProjectTree as ServiceProjectTree,
  VirtualProject as ServiceVirtualProject,
} from "@zcode/services";
import type { Locale, UserInfo, ZCodeTaskMeta, ZCodeTaskUnreadObservation } from "@zcode/shared";
import type { LucideIcon } from "lucide-react";
import type { AppProps, CreateTaskRequest } from "@zui/app-shell/types.js";
import type { CodeViewerSource } from "@zui/lib/codeViewer.js";
import type { Theme } from "@zui/useTheme.js";

export type ProjectTask = ServiceProjectTask & ZCodeTaskMeta;
export type ProjectTaskRef = Pick<ProjectTask, "workspacePath" | "workspaceIdentity" | "taskId" | "taskControl" | "lastUnreadAt" | "pinRevision">;
export type VirtualProject = ServiceVirtualProject & {
  primaryRootStatus?: "available" | "missing" | "unavailable";
};
export type ProjectTree = Omit<ServiceProjectTree, "projects" | "tasks"> & {
  projects: VirtualProject[];
  tasks: ProjectTask[];
};
export type { Locale, Theme };
export interface ProjectAvailability {
  online: boolean;
}
export interface ProjectRowAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  run(): void;
  disabled?: boolean;
  destructive?: boolean;
}
export type ProjectSidebarView = "projects" | "grouped" | "timeline";
export interface SidebarFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  viewerScope?: CodeUiViewerScope;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
}
export interface SidebarFileTreeOpenRequest {
  id: number;
  target: SidebarFileTreeTarget;
}
export interface ProjectSidebarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activePreviewPath?: string | null;
  onOpenFileManager?: (target: SidebarFileTreeTarget) => void;
  onSelectTask: (
    path: string,
    taskId: string,
    workspaceIdentity?: string,
    remoteSessionId?: string,
    expectedUnreadAt?: number,
    unreadObservation?: ZCodeTaskUnreadObservation,
  ) => void;
  onStartDraftInWorkspace: (path: string, identity?: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenBrowserUrl?: (url: string) => void;
  fileTreeOpenRequest?: SidebarFileTreeOpenRequest | null;
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask: () => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onOpenRemoteWorkspace?: () => void;
  theme: Theme;
  onConnectRemote: AppProps["onConnectRemote"];
  onSelectRemoteProject: AppProps["onSelectRemoteProject"];
  onCancelRemoteProject: AppProps["onCancelRemoteProject"];
  onReconnectRemoteWorkspace: AppProps["onReconnectRemoteWorkspace"];
  onLogout?: () => void;
  onLogin?: () => void;
  user?: UserInfo | null;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey?: AppProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"];
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isWebRemoteControl?: boolean;
  isSidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  toggleSidebarShortcutLabel?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  goBackShortcutLabel?: string;
  goForwardShortcutLabel?: string;
  onOpenCommandCenter: () => void;
  onOpenAutomations?: () => void;
  automationsActive?: boolean;
  onOpenPluginStore?: () => void;
  pluginStoreActive?: boolean;
  onFileTreeOpenChange?: (open: boolean) => void;
}
export type {
  IProjectService,
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
export type { WindowHostTaskAddress, WindowHostControllerTaskActivity } from "@zcode/shared/zcode-protocol-v4";
