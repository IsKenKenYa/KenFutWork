/**
 * zcode 照搬：`@/components/coding-plan-quota-reset/CodingPlanQuotaResetStatus.tsx`（references/zcode/packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetStatus.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */

import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { CodingPlanQuotaResetUiStatus } from "@zui/lib/codingPlanQuotaResetUi";
import type { CodingPlanResetType } from "@zui/lib/zcode-shared";
import { CheckIcon, Loader2 } from "lucide-react";

/**
 * 自动重置提示内容（纯展示），供 composer 额度入口的受控 tooltip 使用：
 * - processing：转圈 +「正在重置 5 小时/周额度…」
 * - completed： 绿色勾选 +「5 小时/周额度已重置」
 * 带 role="status" 让读屏在状态切换时朗读。
 */
export function CodingPlanQuotaResetStatusContent({
  status,
  resetType = "FIVE_HOUR",
}: {
  status: CodingPlanQuotaResetUiStatus;
  resetType?: CodingPlanResetType;
}) {
  const { intl } = useZCodeIntl();

  if (status === "processing") {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 text-ui-base"
      >
        <Loader2
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span>
          {intl.formatMessage({
            id:
              resetType === "WEEK"
                ? "codingPlan.quotaReset.processingWeek"
                : "codingPlan.quotaReset.processing",
          })}
        </span>
      </span>
    );
  }

  return (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 text-ui-base text-success"
    >
      <CheckIcon
        className="size-3.5 shrink-0 animate-in zoom-in-75 motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span>
        {intl.formatMessage({
          id:
            resetType === "WEEK"
              ? "codingPlan.quotaReset.doneWeek"
              : "codingPlan.quotaReset.done",
        })}
      </span>
    </span>
  );
}
