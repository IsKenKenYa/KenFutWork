import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useProjectTree } from "@zui/project-sidebar/useProjectTree.js";
import { useTaskGroups } from "@zui/project-sidebar/useTaskGroups.js";
import { useBaseWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";
import { useProjectSidebarPreferences } from "@zui/project-sidebar/useProjectSidebarPreferences.js";

function useDirectoryState() {
  const directory = useProjectTree();
  const groups = useTaskGroups(directory.tree, directory.loading);
  const service = useBaseWorkspaceServices().projectService;
  const preferences = useProjectSidebarPreferences(directory.tree.projects, directory.loading);
  return useMemo(() => ({ ...directory, groups, service, preferences }), [directory, groups, service, preferences]);
}

const Context = createContext<ReturnType<typeof useDirectoryState> | null>(null);

/** 原目录 owner 在本机读取持久 Project/Task；嵌入面复用已有 owner。 */
export function ProjectDirectoryProvider({ children }: { children: ReactNode }) {
  const existing = useContext(Context);
  return existing ? children : <DirectoryOwner>{children}</DirectoryOwner>;
}

function DirectoryOwner({ children }: { children: ReactNode }) {
  const directory = useDirectoryState();
  return <Context.Provider value={directory}>{children}</Context.Provider>;
}

export function useProjectDirectory() {
  const directory = useContext(Context);
  if (!directory) throw new Error("project.directory-provider-required");
  return directory;
}

export function useOptionalProjectDirectory() {
  return useContext(Context);
}
