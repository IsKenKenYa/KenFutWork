import { useCallback, useEffect, useRef } from "react";
import { parseLocalWorkspaceIdentity } from "@zcode/shared";
import type { ProjectSidebarProps, ProjectTask, VirtualProject } from "@zui/project-sidebar/contract.js";
import { getPathLeaf } from "@zui/lib/path.js";
import { resolveProjectFileTarget } from "@zui/project-sidebar/project-file-navigation.js";

export function useProjectFileTree(props: ProjectSidebarProps) {
  const request = useRef(0);
  const consumedRequest = useRef<ProjectSidebarProps["fileTreeOpenRequest"]>(null);
  const cancel = useCallback(() => { request.current++; }, []);
  useEffect(() => cancel, [cancel]);
  useEffect(() => {
    const next = props.fileTreeOpenRequest;
    if (!next || consumedRequest.current === next || !props.onOpenFileManager) return;
    consumedRequest.current = next;
    request.current++;
    props.onOpenFileManager(next.target);
  }, [props.fileTreeOpenRequest, props.onOpenFileManager]);
  const openFiles = useCallback(async (project: VirtualProject, rootPath: string) => {
    const generation = ++request.current;
    const target = await resolveProjectFileTarget({ project, rootPath });
    if (generation === request.current) props.onOpenFileManager?.(target);
  }, [props.onOpenFileManager]);
  const openTaskFiles = useCallback(async (task: ProjectTask) => {
    const generation = ++request.current;
    const identity = parseLocalWorkspaceIdentity(task.workspaceIdentity, task.workspacePath);
    if (!identity || identity.projectId !== task.projectId || task.taskControl?.projectId !== task.projectId)
      throw new Error("任务文件来源已改变，请重新打开。");
    if (generation !== request.current) return;
    props.onOpenFileManager?.({
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
      workspaceName: getPathLeaf(task.workspacePath) || task.workspacePath,
      viewerScope: { kind: "task", taskId: task.taskId },
    });
  }, [props.onOpenFileManager]);
  return { openFiles, openTaskFiles, cancel };
}
