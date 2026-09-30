/**
 * zcode 照搬：`@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.ts`（references/zcode/packages/ui/src/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */

import type {
  CodingPlanQuotaResetDialogConfig,
  CodingPlanQuotaResetDialogResetItem,
  CodingPlanQuotaResetDialogUsageItem,
} from "@zui/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog";
import type { useCodingPlanQuotaResetUi } from "@zui/hooks/useCodingPlanQuotaResetUi";
import type { CodingPlanQuotaResetUiEntry } from "@zui/lib/codingPlanQuotaResetUi";
import type { CodingPlanResetType } from "@zui/lib/zcode-shared";

type CodingPlanQuotaResetUi = ReturnType<typeof useCodingPlanQuotaResetUi>;

function createResetItem(params: {
  enabled: boolean;
  entry: CodingPlanQuotaResetUiEntry | null;
  onReset: () => Promise<void>;
  opportunityVisible: boolean;
  processing: boolean;
  quotaFull: boolean;
  resetType: CodingPlanResetType;
}): CodingPlanQuotaResetDialogResetItem | null {
  const { enabled, entry, opportunityVisible, processing, quotaFull } = params;
  if (
    !enabled ||
    !entry ||
    (!processing &&
      entry.status !== "completed" &&
      (!opportunityVisible || quotaFull))
  ) {
    return null;
  }
  return {
    count: entry.opportunityCount,
    expiresAt: entry.opportunityExpiresAt,
    onReset: params.onReset,
    processing,
    resetType: params.resetType,
  };
}

export function buildCodingPlanQuotaResetDialogConfig(params: {
  fiveHourEnabled: boolean;
  fiveHourQuotaFull: boolean;
  resetUi: CodingPlanQuotaResetUi;
  usageItems: CodingPlanQuotaResetDialogUsageItem[];
  weekEnabled: boolean;
  weekQuotaFull: boolean;
}): CodingPlanQuotaResetDialogConfig {
  const { resetUi } = params;
  const resetItems = [
    createResetItem({
      enabled: params.fiveHourEnabled,
      entry: resetUi.entry,
      onReset: resetUi.reset,
      opportunityVisible: resetUi.opportunityVisible,
      processing: resetUi.processing,
      quotaFull: params.fiveHourQuotaFull,
      resetType: "FIVE_HOUR",
    }),
    createResetItem({
      enabled: params.weekEnabled,
      entry: resetUi.week.entry,
      onReset: resetUi.week.reset,
      opportunityVisible: resetUi.week.opportunityVisible,
      processing: resetUi.week.processing,
      quotaFull: params.weekQuotaFull,
      resetType: "WEEK",
    }),
  ].filter(
    (item): item is CodingPlanQuotaResetDialogResetItem => item !== null,
  );
  return { resetItems, usageItems: params.usageItems };
}
