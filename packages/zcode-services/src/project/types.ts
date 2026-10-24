import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ConversationTaskControl } from "@zcode/shared/zcode-protocol-v4";

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
  deleted?: boolean;
}

export type ProjectTask = Pick<
  ZCodeTaskMeta,
  | "taskId"
  | "traceId"
  | "workspacePath"
  | "workspaceIdentity"
  | "workModes"
  | "title"
  | "titleOverridden"
  | "createdAt"
  | "updatedAt"
  | "mode"
  | "model"
  | "thoughtLevel"
  | "status"
> & {
  projectId: string;
  hostId: "local";
  pinned: boolean;
  archived: boolean;
  taskControl?: ConversationTaskControl;
};

export interface ProjectTree {
  projects: VirtualProject[];
  tasks: ProjectTask[];
  deletedTasks?: Array<{
    taskId: string;
    projectId: string;
    hostId: "local";
  }>;
}

export interface PrepareProjectSessionInput {
  projectId: string;
  hostId?: "local";
  preset?: "code" | "design";
}

export interface PreparedProjectSession {
  projectId: string;
  workspacePath: string;
  workspaceIdentity: string;
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
