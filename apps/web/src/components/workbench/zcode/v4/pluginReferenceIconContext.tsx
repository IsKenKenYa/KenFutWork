/**
 * zcode 照搬：`@/v4/pluginReferenceIconContext.tsx`（references/zcode/packages/ui/src/v4/pluginReferenceIconContext.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import { createContext, useContext } from "react";

interface SessionPluginIconProjection {
  sessionId: string;
  iconByPluginId: ReadonlyMap<string, string>;
}

const PluginReferenceIconContext =
  createContext<SessionPluginIconProjection | null>(null);

export const PluginReferenceIconProvider = PluginReferenceIconContext.Provider;

export function usePluginReferenceIconProjection(): SessionPluginIconProjection | null {
  return useContext(PluginReferenceIconContext);
}
