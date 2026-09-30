/**
 * zcode 照搬：`@/components/ModelInputCapabilityBadge.tsx`（references/zcode/packages/ui/src/components/ModelInputCapabilityBadge.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
import { cn } from "@zui/components/lib/utils";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";

export const MODEL_INPUT_CAPABILITY_BADGE_CLASS_NAME =
  "pointer-events-none inline-flex shrink-0 items-center rounded-full border border-border bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle";

export function ModelInputCapabilityBadge({
  className,
}: {
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "model.capability.vision" });

  return (
    <span
      className={cn(MODEL_INPUT_CAPABILITY_BADGE_CLASS_NAME, className)}
      data-model-input-capability="vision"
      aria-label={label}
      title={label}
    >
      {label}
    </span>
  );
}
