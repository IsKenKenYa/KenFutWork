"use client";

import {
  FLOW_PLUGIN_BUNDLE_NAME,
  type FlowEntry,
  type FlowHostStatusResponse,
  resolveFlowEntry,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";
import { getServerBaseUrl } from "@/lib/env";
import { loadLocalInstance, serverFetch } from "@/lib/local-access";
import { PLUGIN_INVENTORY_CHANGED_EVENT } from "@/lib/plugin-panels";

/**
 * Flow 模式入口的接线层：插件安装态 + 宿主适配层探针 → `resolveFlowEntry`。
 *
 * 拉取时机：本机连接就绪后一次 + 手动 `refresh()`（插件市场装/卸 flow 后工作台要能立即反应，
 * 不等下一次进页面）。两路请求任何一路失败都按「不可用」处理（fail loud 给 reason，
 * 不猜「也许能用」）。
 *
 * **发布纪律（真机踩过）**：两路探针必须**都落定后一次性发布**，中途不给
 * 「插件已答、状态未答」的中间态——那个中间态会按「适配层未就绪」渲染，
 * 主区先闪一条原因再换成画布/入口，深链 `?mode=flow` 也会被弹一下。
 */
export function useFlowHostEntry(enabled = true): {
  entry: FlowEntry | null;
  refresh: () => void;
} {
  const [probe, setProbe] = useState<{
    pluginInstalled: boolean;
    pluginEnabled: boolean;
    status: FlowHostStatusResponse | null;
  } | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener(PLUGIN_INVENTORY_CHANGED_EVENT, refresh);
    return () =>
      window.removeEventListener(PLUGIN_INVENTORY_CHANGED_EVENT, refresh);
  }, [enabled, refresh]);

  /**
   * 本机托管运行时启动期（首次安装/应用刚启动）尚未就绪：每 2 秒重试探针，
   * 就绪后入口自动出现。只在明确回报 `starting` 时轮询，配置错误不空转。
   */
  const starting =
    probe?.pluginInstalled === true &&
    probe.pluginEnabled &&
    probe.status?.runtime?.state === "starting";
  useEffect(() => {
    if (!starting) return;
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [starting, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick 是手动刷新信号（refresh() 递增它以重跑本 effect），effect 体内不读它
  useEffect(() => {
    if (!enabled) {
      setProbe(null);
      return;
    }
    let cancelled = false;

    void (async () => {
      // 首次带 `#connect` 打开时，本机接入换票是异步的：先等它完成，
      // 否则两路探针会撞上 401，Flow 入口要等用户手动刷新才出现。
      await loadLocalInstance().catch(() => undefined);
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
            const flow = body.plugins?.filter(
              (candidate) => candidate.name === FLOW_PLUGIN_BUNDLE_NAME,
            );
            return {
              installed:
                flow?.some((candidate) => candidate.installed === true) ??
                false,
              enabled:
                flow?.some(
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
  return { entry: resolveFlowEntry(probe), refresh };
}
