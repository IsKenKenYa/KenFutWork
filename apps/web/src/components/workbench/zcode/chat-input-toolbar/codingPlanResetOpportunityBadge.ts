/**
 * zcode 照搬：`@/chat-input-toolbar/codingPlanResetOpportunityBadge.ts`（references/zcode/packages/ui/src/chat-input-toolbar/codingPlanResetOpportunityBadge.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
import type { CodingPlanUsageRemainingState } from "@zui/CodingPlanUsageRemainingPanel";
import type { CodingPlanQuotaResetUiController } from "@zui/hooks/useCodingPlanQuotaResetUi";
import {
  findCodingPlanQuotaLimit,
  isCodingPlanQuotaLimitFull,
} from "@zui/lib/codingPlanQuotaPresentation";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetLimit,
} from "@zui/lib/codingPlanQuotaResetUi";

export function resolveChatCodingPlanResetOpportunityBadge(
  state: CodingPlanUsageRemainingState | null,
  resetUi: Pick<
    CodingPlanQuotaResetUiController,
    "entry" | "opportunityVisible" | "week"
  >,
) {
  const limits = state?.visibleSnapshot?.quota?.limits ?? [];
  const fiveHourTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );

  return mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible:
        Boolean(fiveHourTokenLimit) &&
        resetUi.opportunityVisible &&
        !isCodingPlanQuotaLimitFull(fiveHourTokenLimit),
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible:
        Boolean(weeklyTokenLimit) &&
        resetUi.week.opportunityVisible &&
        !isCodingPlanQuotaLimitFull(weeklyTokenLimit),
    },
  ]);
}
