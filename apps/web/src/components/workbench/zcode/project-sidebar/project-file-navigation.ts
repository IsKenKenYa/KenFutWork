import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import type { SidebarFileTreeTarget, VirtualProject } from "@zui/project-sidebar/contract.js";

/** 文件读取目标只取用户选中的 root；身份和执行授权分别由原服务校验。 */
export async function resolveProjectFileTarget(input: {
  project: VirtualProject;
  rootPath: string;
}): Promise<SidebarFileTreeTarget> {
  const { project, rootPath } = input;
  if (!project.roots.some((root) => root.rootPath === rootPath))
    throw new Error("project.root-not-found");
  return {
    workspacePath: rootPath,
    workspaceName: project.name,
    workspaceIdentity: canonicalLocalWorkspaceIdentity(project.id, rootPath),
    viewerScope: { kind: "project", projectId: project.id },
  };
}
