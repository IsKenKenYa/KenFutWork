import type { CodeUiViewerScope } from "@kenfutwork/shared";

export interface CodeViewerWorkspaceScope {
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  viewerScope?: CodeUiViewerScope;
}
