import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";

export interface ProjectMemoryFileSummary {
  name: string;
  /** 已由 MemoryService 校验并限制在本地 Project Memory 根目录内的实际路径。 */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
}

export interface ProjectMemoryTrashItem {
  trashId: string;
  fileName: string | null;
  /** 原始标题；没有索引行时用文件名（去扩展名）。 */
  title: string | null;
  reason: "duplicate" | "orphan" | "dangling-index";
  trashedAt: number;
  /** 已过可恢复窗口时为 false，界面据此禁用恢复并说明原因。 */
  restorable: boolean;
}

export interface IMemoryService {
  /** 列出当前本地 profile 中可查看的 Project Memory。 */
  listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]>;

  /** 原样读取一个 Project Memory Markdown 文件。 */
  readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }>;

  /** 列出一个工作区回收区里的条目；窗口内可恢复。 */
  listTrashedMemories(params: {
    projectId: string;
  }): Promise<ProjectMemoryTrashItem[]>;

  /** 恢复一个回收项；正文同名时服务端自动加后缀。 */
  restoreTrashedMemory(params: {
    projectId: string;
    trashId: string;
  }): Promise<{ fileName: string | null }>;
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory);
