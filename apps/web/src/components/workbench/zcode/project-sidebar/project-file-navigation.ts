import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import type { SidebarFileTreeTarget, VirtualProject } from "@zui/project-sidebar/contract.js";

/** 宿主身份使用项目主目录，用户选中的 root 只控制浏览起点。 */
export async function resolveProjectFileTarget(input: {
  project: VirtualProject;
  rootPath: string;
}): Promise<SidebarFileTreeTarget> {
  const { project, rootPath } = input;
  if (!project.roots.some((root) => root.rootPath === rootPath))
    throw new Error("project.root-not-found");
  const primaryRoot = project.roots.find((root) => root.isPrimary);
  if (!primaryRoot) throw new Error("project.primary-root-not-found");
  return {
    workspacePath: primaryRoot.rootPath,
    browseDirectory: rootPath,
    workspaceName: project.name,
    workspaceIdentity: canonicalLocalWorkspaceIdentity(project.id, primaryRoot.rootPath),
    viewerScope: { kind: "project", projectId: project.id },
  };
}
