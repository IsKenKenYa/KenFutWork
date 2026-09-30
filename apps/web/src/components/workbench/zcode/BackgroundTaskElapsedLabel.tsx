/**
 * zcode 照搬：`@/BackgroundTaskElapsedLabel.tsx`（references/zcode/packages/ui/src/BackgroundTaskElapsedLabel.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀。
 */

import { cn } from "@zui/components/lib/utils";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import {
  getZCodeBackgroundTaskControlItemElapsedMs,
  type ZCodeBackgroundTaskControlItem,
} from "@zui/lib/zcode-shared";
import { useRef } from "react";

export function formatBackgroundTaskElapsedLabel(
  elapsedMs: number,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return formatMessage(
      { id: "chat.longRunning.elapsedMinutesSeconds" },
      { minutes: String(minutes), seconds: String(seconds) },
    );
  }

  return formatMessage(
    { id: "chat.longRunning.elapsedSeconds" },
    { seconds: String(totalSeconds) },
  );
}

function createElapsedBaseline(job: ZCodeBackgroundTaskControlItem) {
  const mountedAt = Date.now();
  return {
    elapsedMs: getZCodeBackgroundTaskControlItemElapsedMs(job, mountedAt),
    key: `${job.jobId}:${job.startedAt ?? "no-start"}:${job.elapsedMs ?? "no-elapsed"}`,
    mountedAt,
  };
}

function elapsedMsForClock(input: {
  baseline: ReturnType<typeof createElapsedBaseline>;
  job: ZCodeBackgroundTaskControlItem;
  now: number;
}) {
  const elapsedFromJob = getZCodeBackgroundTaskControlItemElapsedMs(
    input.job,
    input.now,
  );
  const elapsedFromBaseline =
    input.baseline.elapsedMs +
    Math.max(0, input.now - input.baseline.mountedAt);
  return Math.max(elapsedFromJob, elapsedFromBaseline);
}

export function BackgroundTaskElapsedLabel({
  className,
  job,
  now = Date.now(),
}: {
  className?: string;
  job: ZCodeBackgroundTaskControlItem;
  now?: number;
}) {
  const { intl } = useZCodeIntl();
  const baselineRef = useRef<ReturnType<typeof createElapsedBaseline> | null>(
    null,
  );
  const baselineKey = `${job.jobId}:${job.startedAt ?? "no-start"}:${job.elapsedMs ?? "no-elapsed"}`;
  if (!baselineRef.current || baselineRef.current.key !== baselineKey) {
    baselineRef.current = createElapsedBaseline(job);
  }
  const baseline = baselineRef.current;

  return (
    <span
      className={cn("shrink-0 tabular-nums text-foreground-subtle", className)}
    >
      {formatBackgroundTaskElapsedLabel(
        elapsedMsForClock({
          baseline,
          job,
          now,
        }),
        intl.formatMessage,
      )}
    </span>
  );
}
