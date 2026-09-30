/**
 * zcode 照搬：`@/v4/conversationWorkDuration.ts`（references/zcode/packages/ui/src/v4/conversationWorkDuration.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import type { IntlInstance } from "@zui/i18n/IntlProvider";
import type { Locale } from "@zui/lib/zcode-shared";

function formatDurationUnit(
  value: number,
  messageId: string,
  intl: IntlInstance,
  locale: Locale,
): string {
  const unit = intl.formatMessage({ id: messageId });
  // 中文时长单位需要空格；英文单位本身已带缩写，不额外插入空格。
  return `${value}${locale === "zh-CN" ? " " : ""}${unit}`;
}

/** Desktop 与 Share 共用的工作时长文案，避免同一轮在两个 surface 显示不同单位。 */
export function formatConversationWorkDuration(
  durationMs: number | undefined,
  intl: IntlInstance,
  locale: Locale,
): string | null {
  if (durationMs === undefined) return null;

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0)
    parts.push(
      formatDurationUnit(days, "chat.history.duration.day", intl, locale),
    );
  if (hours > 0)
    parts.push(
      formatDurationUnit(hours, "chat.history.duration.hour", intl, locale),
    );
  if (minutes > 0)
    parts.push(
      formatDurationUnit(minutes, "chat.history.duration.minute", intl, locale),
    );
  if (seconds > 0 || parts.length === 0) {
    parts.push(
      formatDurationUnit(seconds, "chat.history.duration.second", intl, locale),
    );
  }

  return parts.slice(0, 2).join(" ");
}
