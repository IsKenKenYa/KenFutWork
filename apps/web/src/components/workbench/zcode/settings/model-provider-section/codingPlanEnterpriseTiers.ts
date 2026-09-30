/**
 * zcode 照搬：`@/settings/model-provider-section/codingPlanEnterpriseTiers.ts`（references/zcode/packages/ui/src/settings/model-provider-section/codingPlanEnterpriseTiers.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import type { EnterpriseCodingPlanProductDisplay } from "@zui/settings/model-provider-section/enterpriseCodingPlanProducts";

// 2026-09: 原生购买面板（CodingPlanPurchasePanel）整体下线，购买流程切换为内嵌官网
// webview。本文件迁出该面板中仍被设置页（Detail.tsx）与登录恢复逻辑使用的
// 企业套餐分组/档位展示 helper，避免活代码依赖 6200 行死面板文件。

export type PurchaseAudience = "personal" | "team";

export interface EnterpriseCodingPlanProductGroup {
  key: string;
  title: string;
  products: EnterpriseCodingPlanProductDisplay[];
}
