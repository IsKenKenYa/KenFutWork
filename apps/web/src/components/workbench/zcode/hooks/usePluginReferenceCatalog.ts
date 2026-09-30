/**
 * zcode 宿主适配 stub：`@/hooks/usePluginReferenceCatalog` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/usePluginReferenceCatalog.ts
 *
 * zcode 的 Plugin 对话引用 catalog 经 pluginsService RPC 拉取（session/workspace authority）。
 * 本仓无该服务层，故恒返回空 catalog（loading=false、error=null）：`@` 面板的 Plugin 分组
 * 恒为空并自动隐藏。入参（含 refreshRevision / dedupeSessionRequest / suppressErrorLog 选项）
 * 保持原签名，便于后续接通服务时零改动替换。
 * 适配注记：导出签名与原文件一致；数据恒空（stub 降级）。
 */
"use client";

import type { ZCodePluginReferenceCatalogEntry } from "@zui/lib/zcode-shared";

interface PluginReferenceCatalogState {
  entries: ZCodePluginReferenceCatalogEntry[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

interface PluginReferenceCatalogOptions {
  preferredRemoteSessionId?: string;
  /** 显式重试代次；菜单重开时重新查询，关闭菜单不清空已加载的目录。 */
  refreshRevision?: number;
  /** 仅合并当前 runtime 内尚未完成的同一 Session 请求；settle 后立即释放。 */
  dedupeSessionRequest?: boolean;
  suppressErrorLog?: boolean;
}

const EMPTY_STATE: PluginReferenceCatalogState = {
  entries: [],
  authority: null,
  loading: false,
  error: null,
};

export function usePluginReferenceCatalog(
  _workspacePath: string,
  _workspaceIdentity: string | undefined,
  _sessionId: string | null,
  _enabled: boolean,
  _options?: PluginReferenceCatalogOptions,
): PluginReferenceCatalogState {
  return EMPTY_STATE;
}
