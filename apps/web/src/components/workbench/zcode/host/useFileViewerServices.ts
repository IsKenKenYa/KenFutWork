import type { CodeUiViewerScope } from "@kenfutwork/shared";
import { useWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";
import { useMemo } from "react";
import { codeFileServicesForViewer } from "./fileViewerServices.js";

export function useFileViewerServices({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  viewerScope,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  viewerScope?: CodeUiViewerScope;
}) {
  const services = useWorkspaceServices(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const { fileService, fileWatcherService, gitService } = services;
  const taskId = viewerScope?.kind === "task" ? viewerScope.taskId : undefined;
  const projectId =
    viewerScope?.kind === "project" ? viewerScope.projectId : undefined;
  return useMemo(() => {
    const source = { fileService, fileWatcherService, gitService };
    const scope: CodeUiViewerScope | undefined =
      taskId !== undefined
        ? { kind: "task", taskId }
        : projectId !== undefined
          ? { kind: "project", projectId }
          : undefined;
    return scope
      ? (codeFileServicesForViewer(source, scope) ?? source)
      : source;
  }, [fileService, fileWatcherService, gitService, taskId, projectId]);
}
