/**
 * zcode 宿主适配 stub：`@/store/codingPlanQuotaResetState` 的最小等价。
 * 来源：references/zcode/packages/ui/src/store/codingPlanQuotaResetState.ts
 *
 * zcode 的配额重置状态机经 usageStatsService RPC + BroadcastService 跨窗口租约协调
 * 自动播放。本仓无 Coding Plan 订阅链路，也无该服务层，故本 store 不建真实状态机：
 * 只保留照搬件（codingPlanQuotaResetAutoPlay 等）消费的**类型切片**（逐字照搬声明），
 * 运行时入口全部交由 hooks/useCodingPlanQuotaResetUi 的 stub 提供「无订阅」控制器。
 * 适配注记：类型逐字照搬；不导出原文件的 store/协调函数（无消费方）。
 */
"use client";

import type { BroadcastClaimLease } from "@zui/lib/zcode-services";
import type { CodingPlanResetType } from "@zui/lib/zcode-shared";

export interface CodingPlanQuotaResetAutoPlayReservation {
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
  lease: BroadcastClaimLease;
}

export type CodingPlanQuotaResetAutoPlayReservationAttempt =
  | { status: "reserved"; reservation: CodingPlanQuotaResetAutoPlayReservation }
  | { status: "retry"; retryAfterMs: number }
  | { status: "blocked" };
