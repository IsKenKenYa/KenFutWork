"use client";

import {
  FLOW_PLUGIN_BUNDLE_NAME,
  type FlowHostStatusResponse,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";
import { getServerBaseUrl } from "@/lib/env";
import { type FlowEntry, resolveFlowEntry } from "@/lib/flow-embed";
import { serverFetch } from "@/lib/local-access";

/**
 * Flow 模式入口的接线层：插件安装态 + 宿主适配层探针 → `resolveFlowEntry`。
 *
 * 拉取时机：本机连接就绪后一次 + 手动 `refresh()`（插件市场装/卸 flow 后工作台要能立即反应，
 * 不等下一次进页面）。两路请求任何一路失败都按「不可用」处理（fail loud 给 reason，
 * 不猜「也许能用」）。
 *
 * **发布纪律（真机踩过）**：两路探针必须**都落定后一次性发布**，中途不给
 * 「插件已答、状态未答」的中间态——那个中间态会被 `resolveFlowEntry` 判成
 * available=false，工作台的兜底跳转（见 canvas-workbench 的 mode===flow 守卫）
 * 会据此把 `?mode=flow` 改写成 design，Flow 模式一秒后被弹回 Design 画布。
 */
export function useFlowHostEntry(enabled = true): {
  entry: FlowEntry | null;
  refresh: () => void;
} {
  const [probe, setProbe] = useState<{
    pluginInstalled: boolean;
    status: FlowHostStatusResponse | null;
  } | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick 是手动刷新信号（refresh() 递增它以重跑本 effect），effect 体内不读它
  useEffect(() => {
    if (!enabled) {
      setProbe(null);
      return;
    }
    let cancelled = false;

    void (async () => {
      const [pluginInstalled, status] = await Promise.all([
        (async () => {
          try {
            const response = await serverFetch(
              `${getServerBaseUrl()}/api/plugins`,
              { headers: {} },
            );
            if (!response.ok) return false;
            const body = (await response.json()) as {
              plugins?: Array<{ name: string; installed: boolean }>;
            };
            return (
              body.plugins?.some(
                (plugin) =>
                  plugin.name === FLOW_PLUGIN_BUNDLE_NAME && plugin.installed,
              ) ?? false
            );
          } catch {
            return false;
          }
        })(),
        (async () => {
          try {
            const response = await serverFetch(
              `${getServerBaseUrl()}/api/flow/host/status`,
              { headers: {} },
            );
            if (!response.ok) return null;
            return (await response.json()) as FlowHostStatusResponse;
          } catch {
            return null;
          }
        })(),
      ]);
      if (!cancelled) setProbe({ pluginInstalled, status });
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, tick]);

  // 两路都落定前不发布：调用方先不渲染入口也不报错（entry=null）。
  if (!probe) return { entry: null, refresh };
  return { entry: resolveFlowEntry(probe), refresh };
}
