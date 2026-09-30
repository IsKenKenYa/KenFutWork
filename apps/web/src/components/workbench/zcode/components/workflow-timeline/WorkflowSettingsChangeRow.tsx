/**
 * zcode 照搬：`@/components/workflow-timeline/WorkflowSettingsChangeRow.tsx`（references/zcode/packages/ui/src/components/workflow-timeline/WorkflowSettingsChangeRow.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
// ============================================================
// 设置轮的那一行
// ============================================================
// 「配置」的一次修改在转写里留下一个控制轮：没有用户气泡，它的呈现是新 run 的卡，卡上方这一行说
// 改了什么——工具行的单行样式：滑杆图标、「已调整设置」、每项改动一段、时刻，以 `·` 相隔。
// 它是记录，不是控件。

import { workflowSettingsChangeSegments } from "@zui/components/workflow-timeline/workflowSettingsChange";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { WorkflowSettingsAmendMeta } from "@zui/lib/zcode-shared/zcode-protocol-v4";
import { SlidersHorizontalIcon } from "lucide-react";
import { Fragment } from "react";

export function WorkflowSettingsChangeRow({
  amend,
  at,
  providerName,
}: {
  amend: WorkflowSettingsAmendMeta;
  /** 设置轮的时刻；缺席即不写。 */
  at?: number;
  /** providerId → provider 名（与卡上的模型段同一个查找）；缺席退回裸 modelId。 */
  providerName?: (providerId: string) => string | undefined;
}) {
  const { intl } = useZCodeIntl();
  const segments = workflowSettingsChangeSegments(amend, {
    formatMessage: intl.formatMessage.bind(intl),
    ...(providerName === undefined ? {} : { providerName }),
  });
  const time =
    at === undefined
      ? undefined
      : new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(at);
  const parts = [
    intl.formatMessage({ id: "chat.toolCall.workflow.settingsChange.kind" }),
    ...segments,
    ...(time === undefined ? [] : [time]),
  ];
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-0.5 text-ui-base text-foreground-subtle"
      data-testid="workflow-settings-change-row"
    >
      <SlidersHorizontalIcon aria-hidden={true} className="size-4 shrink-0" />
      <span className="flex min-w-0 flex-wrap items-center gap-x-2">
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <span aria-hidden={true} className="text-foreground-subtlest">
                ·
              </span>
            ) : null}
            <span
              className={
                index === 0
                  ? "font-medium"
                  : index === parts.length - 1 && time !== undefined
                    ? "text-foreground-subtlest tabular-nums"
                    : undefined
              }
            >
              {part}
            </span>
          </Fragment>
        ))}
      </span>
    </div>
  );
}
