/**
 * zcode 移植层宿主适配：`@/hooks/useServices` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/useServices.tsx
 *
 * zcode 的 IServiceAccessor 是其 RPC 服务门面（fileService 等）。我们的文件能力走
 * 服务端 HTTP API，不经 RPC；当前照搬组件只消费 `services.fileService.stat` /
 * 媒体预览，暂以「未接通」stub 顶上（抛错即能力缺失，UI 降级）。
 * 后续接通我方文件 API 时在此替换实现，照搬组件零改动。
 */
"use client";

import { createContext, type ReactNode, useContext } from "react";

import type { FileMediaPreview, FileStat } from "../lib/zcode-shared";

/** zcode fileService 的最小切片：照搬组件实际调用的方法。 */
export interface ZCodeFileServiceSlice {
  stat(params: { path: string }): Promise<Pick<FileStat, "type">>;
  readMediaPreview(params: {
    path: string;
    maxBytes?: number;
  }): Promise<FileMediaPreview>;
}

export interface ZCodeServiceSlice {
  fileService: ZCodeFileServiceSlice;
}

const unavailableFileService: ZCodeFileServiceSlice = {
  async stat({ path }) {
    throw new Error(`fileService.stat 未接通（${path}）`);
  },
  async readMediaPreview({ path }) {
    throw new Error(`fileService.readMediaPreview 未接通（${path}）`);
  },
};

const stubServices: ZCodeServiceSlice = {
  fileService: unavailableFileService,
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
