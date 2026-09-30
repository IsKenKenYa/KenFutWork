/**
 * zcode 宿主适配 stub：`@/settings/CodingPlanUpgradeDialogProvider` 的最小等价。
 * 来源：references/zcode/packages/ui/src/settings/CodingPlanUpgradeDialogProvider.tsx
 *
 * zcode 的购买升级面板依赖其账号/订单服务（CodingPlanUpgradeDialog + useCodingPlanEntryPlanList +
 * codingPlanFunnelTelemetry）。本仓是 BYOK Work 平台，无 Coding Plan 购买链路，故不挂 Provider：
 * `useOptionalCodingPlanUpgradeDialog` 恒返回 null，消费方（CodingPlanEntryButton 的 gate）按
 * `dialog?.inventory?.status ?? "ready"` 语义恒走 ready 分支，入口按钮正常渲染、不显示加载/重试态。
 * 后续若接入订阅购买，只需在本文件挂上真实 Provider，照搬组件零改动。
 * 适配注记：导出签名与原文件一致；Provider 不注入 context value（stub 降级）。
 */
"use client";

import { createContext, type ReactNode, useContext } from "react";

interface CodingPlanUpgradeDialogContextValue {
  inventory: { status: "ready" | "loading" | "error"; retry?: () => void };
  openCodingPlanUpgrade: (target: unknown) => boolean;
}

const CodingPlanUpgradeDialogContext =
  createContext<CodingPlanUpgradeDialogContextValue | null>(null);

export function CodingPlanUpgradeDialogProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <CodingPlanUpgradeDialogContext.Provider value={null}>
      {children}
    </CodingPlanUpgradeDialogContext.Provider>
  );
}

export function useCodingPlanUpgradeDialog() {
  const context = useContext(CodingPlanUpgradeDialogContext);
  if (!context) {
    throw new Error(
      "useCodingPlanUpgradeDialog must be used within CodingPlanUpgradeDialogProvider",
    );
  }
  return context;
}

/**
 * 可独立挂载的 conversation pane 使用可选上下文；本仓恒无 Provider，恒返回 null。
 */
export function useOptionalCodingPlanUpgradeDialog() {
  return useContext(CodingPlanUpgradeDialogContext);
}
