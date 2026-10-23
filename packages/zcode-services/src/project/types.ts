export type ProjectRootAccess = "read-only" | "read-write";

export interface ProjectRoot {
  rootPath: string;
  position: number;
  isPrimary: boolean;
  access?: ProjectRootAccess;
}

export interface VirtualProject {
  id: string;
  hostId: "local";
  name: string;
  roots: ProjectRoot[];
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface SaveProjectInput {
  id: string;
  hostId?: "local";
  name?: string;
  roots: string[];
  primaryRoot?: string;
  rootPermissions: Record<string, ProjectRootAccess>;
  expectedRevision: number;
}
