/**
 * zcode 照搬：`@/components/workflow-timeline/WorkflowRosterParts.tsx`（references/zcode/packages/ui/src/components/workflow-timeline/WorkflowRosterParts.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import { cn } from "@zui/components/lib/utils";
import type { StepRunStatus } from "@zui/components/workflow-graph/types";
import type { RosterCounts } from "@zui/components/workflow-timeline/roster-model";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import { CircleCheckIcon, CircleXIcon, LoaderCircleIcon } from "lucide-react";

/**
 * 阶段名册的两件小零件：计数行与量条。
 */
const COUNT_ORDER: readonly StepRunStatus[] = [
  "done",
  "running",
  "failed",
  "pending",
];

function useCountLabels(counts: RosterCounts): Record<StepRunStatus, string> {
  const { intl } = useZCodeIntl();
  const label = (status: StepRunStatus) =>
    intl.formatMessage(
      { id: `chat.toolCall.workflow.timeline.roster.${status}` },
      { count: counts[status] },
    );
  return {
    done: label("done"),
    failed: label("failed"),
    pending: label("pending"),
    running: label("running"),
  };
}

/** 计数行：`✓ n · ◌ n · ✕ n · ○ n`，为零的项缺席；每项的 title 是整句。 */
export function RosterTally({
  className,
  counts,
}: {
  counts: RosterCounts;
  className?: string;
}) {
  const labels = useCountLabels(counts);
  return (
    <div
      className={cn(
        "flex h-3.5 items-center gap-2.5 font-mono text-ui-xs leading-none tabular-nums",
        className,
      )}
      data-testid="workflow-roster-tally"
    >
      {COUNT_ORDER.filter((status) => counts[status] > 0).map((status) => (
        <span
          className={cn(
            "flex items-center gap-[3px]",
            status === "done" && "text-success",
            status === "running" && "text-warning",
            status === "failed" && "text-destructive",
            status === "pending" && "text-foreground-subtlest",
          )}
          data-roster-count={status}
          key={status}
          title={labels[status]}
        >
          {status === "done" ? (
            <CircleCheckIcon aria-hidden={true} className="size-2.5" />
          ) : status === "running" ? (
            <LoaderCircleIcon
              aria-hidden={true}
              className="size-2.5 animate-spin motion-reduce:animate-none"
            />
          ) : status === "failed" ? (
            <CircleXIcon aria-hidden={true} className="size-2.5" />
          ) : (
            <span
              aria-hidden={true}
              className="size-2 rounded-full border-[1.5px] border-current"
            />
          )}
          <span className="font-medium">{counts[status]}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * 量条：段序 done · failed · running · pending，从左到右随阶段结算填满；pending 段用 `--color-border`
 * 作轨道。段宽随计数过渡（`.wf-meter-seg`）。`mini` 是折叠节头上的 44 px 版本。
 */
export function RosterMeter({
  className,
  counts,
  mini = false,
}: {
  counts: RosterCounts;
  className?: string;
  mini?: boolean;
}) {
  const labels = useCountLabels(counts);
  const order: readonly StepRunStatus[] = [
    "done",
    "failed",
    "running",
    "pending",
  ];
  return (
    <div
      aria-label={COUNT_ORDER.map((status) => labels[status]).join(", ")}
      className={cn(
        "flex h-[3px] gap-px overflow-hidden rounded-xs",
        mini && "w-11 shrink-0",
        className,
      )}
      data-testid={
        mini ? "workflow-roster-meter-mini" : "workflow-roster-meter"
      }
      role="img"
    >
      {order
        .filter((status) => counts[status] > 0)
        .map((status) => (
          <span
            className={cn(
              "wf-meter-seg min-w-0.5 basis-0",
              status === "done" && "bg-success",
              status === "failed" && "bg-destructive",
              status === "running" && "bg-warning",
              status === "pending" && "bg-border",
            )}
            data-meter-segment={status}
            key={status}
            style={{ flexGrow: counts[status] }}
            title={labels[status]}
          />
        ))}
    </div>
  );
}
