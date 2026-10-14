"use client";

import {
  FLOW_PLUGIN_BUNDLE_NAME,
  type FlowEntry,
  type FlowHostStatusResponse,
  resolveFlowEntry,
} from "@kenfutwork/shared";
import { usePluginHostEntry } from "@/hooks/use-plugin-host-entry";

/**
 * Flow 模式入口的接线层：插件安装态 + 宿主适配层探针 → `resolveFlowEntry`。
 *
 * 两路探针的拉取时机与发布纪律见 `usePluginHostEntry`（共用实现，
 * 避免 flow / OpenDesign 两份拷贝把「都落定后一次性发布」的纪律走岔）。
 */
export function useFlowHostEntry(enabled = true): {
  entry: FlowEntry | null;
  refresh: () => void;
} {
  return usePluginHostEntry<FlowHostStatusResponse, FlowEntry>({
    enabled,
    bundleName: FLOW_PLUGIN_BUNDLE_NAME,
    statusPath: "/api/flow/host/status",
    resolve: resolveFlowEntry,
  });
}
