/**
 * zcode 移植层宿主适配：`@/hooks/usePlatform` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/usePlatform.tsx
 *
 * 我们宿主（Web / Tauri 桌面）尚无「已安装编辑器枚举 / openInEditor / 文件管理器」能力，
 * 故 platform stub 的对应方法一律返回失败/空——UI 据此降级（隐藏「在编辑器中打开」等入口，
 * 符合「未接通不出现」纪律）。openExternal 接到我们已有的右栏浏览器面板 / 系统浏览器口径。
 * 后续 Tauri 桌面落地编辑器检测时，只需替换本文件的 stub 实现，照搬组件零改动。
 */
"use client";

import { createContext, type ReactNode, useCallback, useContext } from "react";

import type {
  EditorInfo,
  OpenInEditorOptions,
  RemoteTarget,
  SaveFileRequest,
  SaveFileResult,
} from "../lib/zcode-shared.js";

/** zcode IPlatformService 的最小切片：只声明照搬组件实际调用的方法。 */
export interface ZCodePlatformSlice {
  /** 在系统浏览器打开外链。 */
  openExternal(url: string): void;
  /** 获取系统中已安装的编辑器/终端列表（含图标）。 */
  getInstalledEditors(): Promise<EditorInfo[]>;
  /** 用指定编辑器打开路径。 */
  openInEditor(
    editorId: string,
    path: string,
    options?: OpenInEditorOptions,
  ): Promise<{ success: boolean; error?: string }>;
  /** 在文件管理器中显示。 */
  openInFileManager(
    path: string,
  ): Promise<{ success: boolean; error?: string }>;
  /** 用宿主原生另存为对话框写入文件；普通 Web 端不实现（zcode IPlatformService.saveFile 同为可选）。 */
  saveFile?(payload: SaveFileRequest): Promise<SaveFileResult>;
  /** 选择目录。 */
  selectDirectory(): Promise<string | null>;
  /** 连接远程（我们宿主未接通，恒失败）。 */
  connectRemote(
    options: RemoteTarget,
    requestId?: string,
  ): Promise<{ success: boolean; error?: string }>;
}

const unavailable = (capability: string) => ({
  success: false as const,
  error: `${capability}-unavailable`,
});

const stubPlatform: ZCodePlatformSlice = {
  openExternal(url) {
    // 系统浏览器兜底；右栏浏览器面板的接管在组件 onClick 里先行处理（与 zcode 同口径）。
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  },
  async getInstalledEditors() {
    return [];
  },
  async openInEditor(_editorId, path) {
    return unavailable(`openInEditor:${path}`);
  },
  async openInFileManager(path) {
    return unavailable(`openInFileManager:${path}`);
  },
  async selectDirectory() {
    return null;
  },
  async connectRemote(_options) {
    return unavailable("connectRemote");
  },
};

const PlatformContext = createContext<ZCodePlatformSlice | null>(null);

export function PlatformProvider({
  platform,
  children,
}: {
  platform: ZCodePlatformSlice;
  children: ReactNode;
}) {
  return (
    <PlatformContext.Provider value={platform}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): ZCodePlatformSlice {
  const ctx = useOptionalPlatform();
  if (!ctx) {
    throw new Error("usePlatform 必须在 PlatformProvider 内使用");
  }
  return ctx;
}

export function useOptionalPlatform(): ZCodePlatformSlice | null {
  return useContext(PlatformContext);
}

/** 选择目录的便捷 hook */
export function useSelectDirectory() {
  const platform = usePlatform();
  return useCallback(() => platform.selectDirectory(), [platform]);
}

/** 连接远程的便捷 hook */
export function useConnectRemote() {
  const platform = usePlatform();
  return useCallback(
    async (options: RemoteTarget, requestId?: string) => {
      const result = await platform.connectRemote(options, requestId);
      if (!result.success) {
        throw new Error(result.error || "Connection failed");
      }
    },
    [platform],
  );
}

/**
 * 无 Provider 时的兜底 platform（zcode 组件在缺失 Provider 的测试/预览场景降级用）。
 * 与 stubPlatform 同一实例：能力全 unavailable，openExternal 走系统浏览器。
 */
export function getFallbackPlatform(): ZCodePlatformSlice {
  return stubPlatform;
}

export { stubPlatform as zcodeStubPlatform };
