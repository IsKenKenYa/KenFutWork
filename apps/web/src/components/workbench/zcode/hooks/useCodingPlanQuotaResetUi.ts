/**
 * zcode 宿主适配 stub：`@/hooks/useCodingPlanQuotaResetUi` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/useCodingPlanQuotaResetUi.ts
 *
 * zcode 的配额重置 UI 状态机经 usageStatsService RPC + BroadcastService 租约协调，
 * 含手动核销、自动播放确认、entitlement 刷新等编排（原文件 887 行）。本仓是 BYOK Work
 * 平台，无 Coding Plan 订阅链路，故控制器恒处于「无订阅」态：entry 恒 null、
 * opportunityVisible/processing/done/statusVisible 恒 false——消费方（contextUsage /
 * 重置机会徽标 / 自动播放协调）按原降级分支整体隐藏重置入口，不发起任何服务调用。
 * 类型（CodingPlanQuotaResetUiController 族）逐字照搬原文件声明，保证照搬组件零改动。
 * 适配注记：导出签名与原文件一致；数据恒「无订阅」（stub 降级）。
 */
"use client";

import type { CodingPlanQuotaResetUiEntry } from "@zui/lib/codingPlanQuotaResetUi";
import type {
  CodingPlanResetType,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zui/lib/zcode-shared";
import type {
  CodingPlanQuotaResetAutoPlayReservation,
  CodingPlanQuotaResetAutoPlayReservationAttempt,
} from "@zui/store/codingPlanQuotaResetState";

export interface CodingPlanQuotaResetTypeController {
  entry: CodingPlanQuotaResetUiEntry | null;
  /** 服务端下发的手动重置机会可见。 */
  opportunityVisible: boolean;
  /** 手动 use + status 对账中。 */
  processing: boolean;
  /** 已拿到服务端 used_at。 */
  done: boolean;
  statusVisible: boolean;
  /** 发起手动核销；失败 reject 供 Action 恢复交互。 */
  reset: () => Promise<void>;
}

export interface CodingPlanQuotaResetUiController
  extends CodingPlanQuotaResetTypeController {
  enabled: boolean;
  week: CodingPlanQuotaResetTypeController;
  /** Composer 申请临时播放 reservation；此阶段不写 played。 */
  reserveAutomaticCompletion: (
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  /** 组件仍有效且即将展示时提交 played。 */
  commitAutomaticCompletion: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => boolean;
  /** 组件在 commit 前失效时释放 reservation。 */
  releaseAutomaticCompletion: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;
}

const IDLE_TYPE_CONTROLLER: CodingPlanQuotaResetTypeController = {
  entry: null,
  opportunityVisible: false,
  processing: false,
  done: false,
  statusVisible: false,
  reset: () => Promise.resolve(),
};

const IDLE_CONTROLLER: CodingPlanQuotaResetUiController = {
  ...IDLE_TYPE_CONTROLLER,
  enabled: false,
  week: IDLE_TYPE_CONTROLLER,
  reserveAutomaticCompletion: () => Promise.resolve({ status: "blocked" }),
  commitAutomaticCompletion: () => false,
  releaseAutomaticCompletion: () => Promise.resolve(),
};

export function useCodingPlanQuotaResetUi(_params: {
  sourceKey: string | null | undefined;
  preferredProviderId?: string | null | undefined;
  accountAccess?:
    | ZCodeProviderAccountAccess
    | ZCodeAccountAccess
    | null
    | undefined;
  enabled?: boolean | undefined;
  onEntitlementRefresh?: (() => void | Promise<void>) | undefined;
}): CodingPlanQuotaResetUiController {
  // 本仓无订阅链路：不订阅任何 store / 服务，恒返回同一「无订阅」控制器实例。
  return IDLE_CONTROLLER;
}
