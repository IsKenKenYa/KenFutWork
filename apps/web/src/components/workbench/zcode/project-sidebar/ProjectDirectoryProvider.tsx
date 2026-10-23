import { createContext, useContext, type ReactNode } from "react";
import { useProjectTree } from "@zui/project-sidebar/useProjectTree.js";

const Context = createContext<ReturnType<typeof useProjectTree> | null>(null);

/** 原目录 owner 在本机读取持久 Project/Task；嵌入面复用已有 owner。 */
export function ProjectDirectoryProvider({ children }: { children: ReactNode }) {
  const existing = useContext(Context);
  return existing ? children : <DirectoryOwner>{children}</DirectoryOwner>;
}

function DirectoryOwner({ children }: { children: ReactNode }) {
  const directory = useProjectTree();
  return <Context.Provider value={directory}>{children}</Context.Provider>;
}

export function useProjectDirectory() {
  const directory = useContext(Context);
  if (!directory) throw new Error("project.directory-provider-required");
  return directory;
}
