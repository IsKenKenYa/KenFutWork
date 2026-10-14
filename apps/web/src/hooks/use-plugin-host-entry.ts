"use client";

import { useCallback, useEffect, useState } from "react";
import { getServerBaseUrl } from "@/lib/env";
import { serverFetch } from "@/lib/local-access";
import { PLUGIN_INVENTORY_CHANGED_EVENT } from "@/lib/plugin-panels";

/**
 * 「产品入口插件 + 宿主适配层」双路门控的共用接线层。
 *
 * 入口纪律（`AGENTS.md` 不变量）：以插件形态交付的功能，**未安装插件或宿主适配层未就绪时
 * 不出现入口**——不摆空壳、不放假开关。判定本身是各功能自己的纯函数（如
 * `resolveFlowEntry` / `resolveOpenDesignEntry`），这里只负责把两路探针拉回来。
 *
 * 拉取时机：本机连接就绪后一次 + 手动 `refresh()`（插件市场装/卸后工作台要能立即反应，
 * 不等下一次进页面）。两路请求任何一路失败都按「不可用」处理（fail loud 给 reason，
 * 不猜「也许能用」）。
 *
 * **发布纪律（真机踩过，flow 模式一秒被弹回）**：两路探针必须**都落定后一次性发布**，
 * 中途不给「插件已答、状态未答」的中间态——那个中间态会被判定函数读成 available=false，
 * 父页的深链兜底会据此把 `?mode=…` 回落，入口一闪就没了。
 */
export interface PluginHostProbe<TStatus> {
  /** 产品入口插件（`bundleName`）是否已安装。 */
  pluginInstalled: boolean;
  /** 已安装且已启用。 */
  pluginEnabled: boolean;
  /** 宿主适配层状态；null = 探针请求失败。 */
  status: TStatus | null;
}

export function usePluginHostEntry<TStatus, TEntry>(input: {
  /** false 时不发请求、不发布（如调用方自己已知道入口不该出现）。 */
  enabled?: boolean;
  /** 产品入口插件的 bundle 名（`GET /api/plugins` 里的 `name`）。 */
  bundleName: string;
  /** 宿主能力探针路径（如 `/api/flow/host/status`）。 */
  statusPath: string;
  /** 两路都落定后的纯判定。 */
  resolve: (probe: PluginHostProbe<TStatus>) => TEntry;
}): { entry: TEntry | null; refresh: () => void } {
  const { enabled = true, bundleName, statusPath, resolve } = input;
  const [probe, setProbe] = useState<PluginHostProbe<TStatus> | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener(PLUGIN_INVENTORY_CHANGED_EVENT, refresh);
    return () =>
      window.removeEventListener(PLUGIN_INVENTORY_CHANGED_EVENT, refresh);
  }, [enabled, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick 是手动刷新信号（refresh() 递增它以重跑本 effect），effect 体内不读它
  useEffect(() => {
    if (!enabled) {
      setProbe(null);
      return;
    }
    let cancelled = false;

    void (async () => {
      const [plugin, status] = await Promise.all([
        (async () => {
          try {
            const response = await serverFetch(
              `${getServerBaseUrl()}/api/plugins`,
              { headers: {} },
            );
            if (!response.ok) return { installed: false, enabled: false };
            const body = (await response.json()) as {
              plugins?: Array<{
                name: string;
                installed: boolean;
                enabled: boolean;
              }>;
            };
            const matches = body.plugins?.filter(
              (candidate) => candidate.name === bundleName,
            );
            return {
              installed:
                matches?.some((candidate) => candidate.installed === true) ??
                false,
              enabled:
                matches?.some(
                  (candidate) =>
                    candidate.installed === true && candidate.enabled === true,
                ) ?? false,
            };
          } catch {
            return { installed: false, enabled: false };
          }
        })(),
        (async () => {
          try {
            const response = await serverFetch(
              `${getServerBaseUrl()}${statusPath}`,
              { headers: {} },
            );
            if (!response.ok) return null;
            return (await response.json()) as TStatus;
          } catch {
            return null;
          }
        })(),
      ]);
      if (!cancelled)
        setProbe({
          pluginInstalled: plugin.installed,
          pluginEnabled: plugin.enabled,
          status,
        });
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, bundleName, statusPath, tick]);

  // 两路都落定前不发布：调用方先不渲染入口也不报错（entry=null）。
  if (!probe) return { entry: null, refresh };
  return { entry: resolve(probe), refresh };
}
