import { ServiceChannels, type FileEntry } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  MoveProjectTaskInput,
  PrepareProjectSessionInput,
  PreparedProjectSession,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
} from "./types.js";

export type {
  CreateProjectInput,
  EditProjectInput,
  MoveProjectTaskInput,
  ProjectRoot,
  ProjectRootAccess,
  PinProjectInput,
  ProjectTask,
  ProjectTree,
  PrepareProjectSessionInput,
  PreparedProjectSession,
  SaveProjectInput,
  VirtualProject,
} from "./types.js";

/** 当前本机宿主的权威项目服务；目录修改仅影响之后创建的 Task。 */
export interface IProjectService {
  /** 只准备所选项目的当前目录身份；Task 仍由原首发／预热入口创建。 */
  prepareSession(input: PrepareProjectSessionInput): Promise<PreparedProjectSession>;
  readDirectory(params?: {
    hostId?: "local";
    path?: string;
    includeHidden?: boolean;
  }): Promise<{ path: string; entries: FileEntry[] }>;
  readProjects(params?: {
    includeDeleted?: false;
    hostId?: "local";
  }): Promise<VirtualProject[]>;
  /** 同一只读快照投影项目与持久 Task；不改变目录授权或启动 Agent。 */
  readTree(params?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    hostId?: "local";
  }): Promise<ProjectTree>;
  saveProject(input: SaveProjectInput): Promise<VirtualProject>;
  moveTask(input: MoveProjectTaskInput): Promise<void>;
  deleteProject(id: string, hostId?: "local"): Promise<void>;
}

export const IProjectService = createServiceDescriptor<IProjectService>(
  ServiceChannels.Project,
);
