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

interface ProjectSaveFields {
  hostId?: "local";
  name?: string;
  roots: string[];
  primaryRoot?: string;
  rootPermissions: Record<string, ProjectRootAccess>;
}

export interface EditProjectInput extends ProjectSaveFields {
  id: string;
  expectedRevision: number;
}

export interface CreateProjectInput extends ProjectSaveFields {
  creationId: string;
  kind: "code" | "design";
  directoryChoice?: "independent";
}

export type SaveProjectInput = EditProjectInput | CreateProjectInput;
