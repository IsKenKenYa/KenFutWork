/**
 * zcode 宿主适配 stub：`@/hooks/useSettingService` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/useSettingService.ts
 *
 * zcode 的应用设置经 settingService RPC 读写 + 广播通道跨窗口同步。本仓无该服务层，
 * 故恒返回「无设置」快照：settings 恒 null、loading=false、error=null——消费方
 * （useShortcutBindings 的快捷键覆盖、useRecentProjects 等）按原降级分支走默认值。
 * update/refresh 保留为可调用的空操作，签名与原文件一致。
 * 后续接通设置服务时替换本实现即可，照搬组件零改动。
 * 适配注记：导出签名与原文件一致；数据恒空（stub 降级）。
 */
"use client";

import { useCallback } from "react";

interface AppSettingsShape {
  shortcutBindings?: Record<string, string[]>;
  recentProjects?: string[];
  [key: string]: unknown;
}

/** 与 zcode SettingsSnapshot 同形状。 */
export interface SettingsSnapshot {
  settings: AppSettingsShape | null;
  loading: boolean;
  error: unknown | null;
}

const IDLE_SNAPSHOT: SettingsSnapshot = {
  settings: null,
  loading: false,
  error: null,
};

/** 获取和更新应用设置（stub：恒空设置、写操作空转）。 */
export function useSettings(): {
  settings: AppSettingsShape | null;
  loading: boolean;
  error: unknown | null;
  update: (patch: Partial<AppSettingsShape>) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const update = useCallback(
    async (_patch: Partial<AppSettingsShape>) => {},
    [],
  );
  const refresh = useCallback(async () => {}, []);
  return {
    settings: IDLE_SNAPSHOT.settings,
    loading: IDLE_SNAPSHOT.loading,
    error: IDLE_SNAPSHOT.error,
    update,
    refresh,
  };
}

/** 最近项目列表的便捷 hook（stub：恒空列表、写入空转）。 */
export function useRecentProjects() {
  const { settings, loading, update } = useSettings();
  return {
    recentProjects: settings?.recentProjects ?? [],
    loading,
    addProject: async (path: string) => {
      const current = settings?.recentProjects ?? [];
      const updated = [path, ...current.filter((p) => p !== path)].slice(0, 10);
      await update({ recentProjects: updated });
    },
  };
}
