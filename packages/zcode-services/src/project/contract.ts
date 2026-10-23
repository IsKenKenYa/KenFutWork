import { ServiceChannels, type FileEntry } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { SaveProjectInput, VirtualProject } from "./types.js";

export type {
  ProjectRoot,
  ProjectRootAccess,
  SaveProjectInput,
  VirtualProject,
} from "./types.js";

/** 当前本机宿主的权威项目服务；目录修改仅影响之后创建的 Task。 */
export interface IProjectService {
  readDirectory(params?: {
    hostId?: "local";
    path?: string;
    includeHidden?: boolean;
  }): Promise<{ path: string; entries: FileEntry[] }>;
  readProjects(params?: {
    includeDeleted?: false;
    hostId?: "local";
  }): Promise<VirtualProject[]>;
  saveProject(input: SaveProjectInput): Promise<VirtualProject>;
  deleteProject(id: string, hostId?: "local"): Promise<void>;
}

export const IProjectService = createServiceDescriptor<IProjectService>(
  ServiceChannels.Project,
);
