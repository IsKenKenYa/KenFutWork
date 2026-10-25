"use client";

import {
  type WorkEntry,
  type WorkHostStatusResponse,
  WORK_PLUGIN_BUNDLE_NAME,
  resolveWorkEntry,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";
import { getServerBaseUrl } from "@/lib/env";
import { serverFetch } from "@/lib/local-access";
import { PLUGIN_INVENTORY_CHANGED_EVENT } from "@/lib/plugin-panels";

/**
 * Work 模式入口的接线层：插件安装态 + 宿主适配层探针 → `resolveWorkEntry`。
 *
 * 拉取时机与发布纪律同 `useFlowHostEntry`（真机踩过）：本机连接就绪后一次 +
 * 手动 `refresh()`（插件市场装/卸 work 后工作台要能立即反应）；两路探针必须
 * **都落定后一次性发布**，中途不给「插件已答、状态未答」的中间态——那个中间态
 * 会被判成 available=false，父页深链兜底会把 `?mode=work` 错误回落。
 */
export function useWorkHostEntry(enabled = true): {
  entry: WorkEntry | null;
  refresh: () => void;
} {
  const [probe, setProbe] = useState<{
    pluginInstalled: boolean;
    pluginEnabled: boolean;
    status: WorkHostStatusResponse | null;
  } | null>(null);
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
            const work = body.plugins?.filter(
              (candidate) => candidate.name === WORK_PLUGIN_BUNDLE_NAME,
            );
            return {
              installed:
                work?.some((candidate) => candidate.installed === true) ??
                false,
              enabled:
                work?.some(
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
              `${getServerBaseUrl()}/api/work/host/status`,
              { headers: {} },
            );
            if (!response.ok) return null;
            return (await response.json()) as WorkHostStatusResponse;
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
  }, [enabled, tick]);

  // 两路都落定前不发布：调用方先不渲染入口也不报错（entry=null）。
  if (!probe) return { entry: null, refresh };
  return { entry: resolveWorkEntry(probe), refresh };
}
