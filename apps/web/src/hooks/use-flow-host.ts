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
 */
export function useFlowHostEntry(enabled = true): {
  entry: FlowEntry | null;
  refresh: () => void;
} {
  const [pluginInstalled, setPluginInstalled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<FlowHostStatusResponse | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick 是手动刷新信号（refresh() 递增它以重跑本 effect），effect 体内不读它
  useEffect(() => {
    if (!enabled) {
      setPluginInstalled(null);
      setStatus(null);
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const response = await serverFetch(
          `${getServerBaseUrl()}/api/plugins`,
          {
            headers: {},
          },
        );
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as {
          plugins?: Array<{ name: string; installed: boolean }>;
        };
        if (cancelled) return;
        setPluginInstalled(
          body.plugins?.some(
            (plugin) =>
              plugin.name === FLOW_PLUGIN_BUNDLE_NAME && plugin.installed,
          ) ?? false,
        );
      } catch {
        if (!cancelled) setPluginInstalled(false);
      }

      try {
        const response = await serverFetch(
          `${getServerBaseUrl()}/api/flow/host/status`,
          { headers: {} },
        );
        if (!response.ok) throw new Error(String(response.status));
        if (cancelled) return;
        setStatus((await response.json()) as FlowHostStatusResponse);
      } catch {
        if (!cancelled) setStatus(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, tick]);

  // 两路都没回来过（未启用 / 首次加载中）→ null：调用方先不渲染入口也不报错。
  if (pluginInstalled === null) return { entry: null, refresh };
  return { entry: resolveFlowEntry({ pluginInstalled, status }), refresh };
}
