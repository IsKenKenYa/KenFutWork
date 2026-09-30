/**
 * zcode 照搬：`@/components/workflow-timeline/WorkflowStationMeta.tsx`（references/zcode/packages/ui/src/components/workflow-timeline/WorkflowStationMeta.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import type { TimelineStation } from "@zui/components/workflow-timeline/timeline-model";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import { Repeat2Icon } from "lucide-react";

/** 站头元数据（从 `WorkflowTimeline.tsx` 拆出以守 400 行）：`⟳ n` 轮次（只在循环上的站）与 `a/b` 步数分数（只在观察到节点后）。 */
export function StationMeta({ station }: { station: TimelineStation }) {
  const { intl } = useZCodeIntl();
  const showRounds = station.onLoop && station.rounds > 0;
  if (!showRounds && station.fraction === undefined) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
      {showRounds ? (
        <span
          className="flex items-center gap-1"
          data-testid="workflow-timeline-rounds"
          title={intl.formatMessage(
            { id: "chat.toolCall.workflow.timeline.rounds" },
            { count: station.rounds },
          )}
        >
          <Repeat2Icon aria-hidden={true} className="size-2.5" />
          {station.rounds}
        </span>
      ) : null}
      {showRounds && station.fraction !== undefined ? (
        <span aria-hidden={true}>·</span>
      ) : null}
      {station.fraction === undefined ? null : (
        <span className="text-ui-sm" data-testid="workflow-timeline-fraction">
          {station.fraction.settled}/{station.fraction.observed}
        </span>
      )}
    </span>
  );
}
