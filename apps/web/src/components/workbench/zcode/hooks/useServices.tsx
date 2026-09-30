/**
 * zcode 移植层宿主适配：`@/hooks/useServices` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/useServices.tsx
 *
 * zcode 的 IServiceAccessor 是其 RPC 服务门面（fileService 等）。我们的文件能力走
 * 服务端 HTTP API，不经 RPC；当前照搬组件只消费 `services.fileService.stat` /
 * 媒体预览，暂以「未接通」stub 顶上（抛错即能力缺失，UI 降级）。
 * 后续接通我方文件 API 时在此替换实现，照搬组件零改动。
 * 适配注记：P5 追加 `subagentsService`（ISubagentsService，@zui/lib/zcode-services 宿主
 * stub 类型）——照搬件 hooks/useSubagents 经 useServices 解构该服务；本仓无 RPC 层，
 * 注入恒抛错实现，subagentsContextStore/subagentsStore 落 error 态、agents 恒空（UI 降级）。
 */
"use client";

import { createContext, type ReactNode, useContext } from "react";

import type { ISubagentsService } from "../lib/zcode-services";
import type {
  FileMediaPreview,
  FileStat,
  WorkspaceFileEntry,
} from "../lib/zcode-shared";

/** zcode fileService 的最小切片：照搬组件实际调用的方法。 */
export interface ZCodeFileServiceSlice {
  stat(params: { path: string }): Promise<Pick<FileStat, "type">>;
  readMediaPreview(params: {
    path: string;
    maxBytes?: number;
  }): Promise<FileMediaPreview>;
  /** 与 zcode IFileService.searchWorkspaceFiles 同形状（WorkspaceFileSearchParams 切片）。 */
  searchWorkspaceFiles(params: {
    rootPath: string;
    workspaceIdentity?: string | undefined;
    query: string;
    limit?: number;
    /** 无命中补扫：绕过尚未过期的文件索引。 */
    refresh?: boolean;
  }): Promise<WorkspaceFileEntry[]>;
}

export interface ZCodeServiceSlice {
  fileService: ZCodeFileServiceSlice;
  subagentsService: ISubagentsService;
}

const unavailableFileService: ZCodeFileServiceSlice = {
  async stat({ path }) {
    throw new Error(`fileService.stat 未接通（${path}）`);
  },
  async searchWorkspaceFiles() {
    throw new Error("fileService.searchWorkspaceFiles 未接通");
  },
  async readMediaPreview({ path }) {
    throw new Error(`fileService.readMediaPreview 未接通（${path}）`);
  },
};

/** 恒抛错的 subagents 服务占位：调用即「未接通」，store 侧落 error 态、agents 恒空。 */
const unavailableSubagentsService: ISubagentsService = {
  async list() {
    throw new Error("subagentsService.list 未接通");
  },
  async setEnabled() {
    throw new Error("subagentsService.setEnabled 未接通");
  },
  async createAgent() {
    throw new Error("subagentsService.createAgent 未接通");
  },
  async updateAgent() {
    throw new Error("subagentsService.updateAgent 未接通");
  },
  async deleteAgent() {
    throw new Error("subagentsService.deleteAgent 未接通");
  },
};

const stubServices: ZCodeServiceSlice = {
  fileService: unavailableFileService,
  subagentsService: unavailableSubagentsService,
};

const ServiceContext = createContext<ZCodeServiceSlice | null>(null);

export function ServiceProvider({
  services,
  children,
}: {
  services: ZCodeServiceSlice;
  children: ReactNode;
}) {
  return (
    <ServiceContext.Provider value={services}>
      {children}
    </ServiceContext.Provider>
  );
}

export function useServices(): ZCodeServiceSlice {
  const ctx = useContext(ServiceContext);
  if (!ctx) {
    throw new Error("useServices 必须在 ServiceProvider 内使用");
  }
  return ctx;
}

export function useOptionalServices(): ZCodeServiceSlice | null {
  return useContext(ServiceContext);
}

export { stubServices as zcodeStubServices };
