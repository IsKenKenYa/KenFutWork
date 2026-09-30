/**
 * zcode 宿主适配 stub：`@/hooks/usePluginStoreOrder` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/usePluginStoreOrder.ts
 *
 * zcode 的插件市场排序快照来自 clientConfigService（Host 配置服务）。本仓无该服务，
 * 恒返回 null order：消费方按「无自定义排序」分支走默认顺序。refresh 保留为可调用
 * 的空操作，签名与原文件一致。后续接通配置服务时替换本实现即可，照搬组件零改动。
 * 适配注记：数据恒空（stub 降级）。
 */
"use client";

import type { PluginStoreOrder } from "@zui/lib/zcode-shared";

import { useCallback } from "react";

export function usePluginStoreOrder(_enabled = true): {
  order: PluginStoreOrder | null;
  refresh: (forceRefresh?: boolean) => Promise<void>;
} {
  const refresh = useCallback(async (_forceRefresh = false) => {}, []);

  return { order: null, refresh };
}
