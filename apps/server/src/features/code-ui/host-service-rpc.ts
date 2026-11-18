import type { CodeUiViewerScope } from "@kenfutwork/shared";

export interface CodeUiHostTargetRequest {
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  viewerScope?: CodeUiViewerScope | undefined;
}
export interface CodeUiHostTarget {
  instanceId: string;
  projectId: string;
  rootDirectory: string;
  viewerScope: CodeUiViewerScope;
}
export interface CodeUiHostConnection {
  connectionId: string;
  instanceId: string;
}
