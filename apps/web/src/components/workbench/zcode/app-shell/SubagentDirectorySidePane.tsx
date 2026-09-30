/**
 * zcode 照搬：`@/app-shell/SubagentDirectorySidePane.tsx`（references/zcode/packages/ui/src/app-shell/SubagentDirectorySidePane.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import { Button } from "@zui/components/ui/button";
import { useSessionSubagents } from "@zui/hooks/useSessionSubagents";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import { formatTaskRelativeTime } from "@zui/lib/taskListItemPresentation";
import type {
  OpenScopedSubagentSideTabRequest,
  SubagentDirectorySidePaneTab,
} from "@zui/lib/workspaceSidePane";
import type { ZCodeSessionEndedSubagent } from "@zui/lib/zcode-shared";
import type { RunningSubagentSummary } from "@zui/lib/zcode-shared/zcode-protocol-v4";
import type { PaneWorkspaceScope } from "@zui/v4/paneLayoutStore";
import type { SessionLease } from "@zui/v4/sessionDataLayer";
import { useConversationProjection } from "@zui/v4/useConversationProjection";
import {
  useV4Conversation,
  V4PaneConversationProvider,
} from "@zui/v4/V4ConversationContext";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

type DirectoryItem = RunningSubagentSummary | ZCodeSessionEndedSubagent;

const EMPTY_RUNNING: readonly RunningSubagentSummary[] = [];

function buildSubagentDirectoryOpenRequest(
  tab: SubagentDirectorySidePaneTab,
  item: DirectoryItem,
): OpenScopedSubagentSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity
      ? { workspaceIdentity: tab.workspaceIdentity }
      : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    rootSessionId: tab.rootSessionId,
    parentSessionId: tab.parentSessionId,
    childSessionId: item.childSessionId,
    subagentType: item.subagentType,
    title: item.title,
  };
}

function StatusIcon({ status }: { status: DirectoryItem["status"] }) {
  const className = "size-4 shrink-0";
  switch (status) {
    case "running":
      return (
        <LoaderCircleIcon
          aria-hidden={true}
          className={`${className} animate-spin`}
        />
      );
    case "waiting":
    case "blocked":
      return <PauseCircleIcon aria-hidden={true} className={className} />;
    case "success":
      return <CheckCircle2Icon aria-hidden={true} className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden={true} className={className} />;
    case "cancelled":
      return <BanIcon aria-hidden={true} className={className} />;
    case "lost":
      return <CircleDashedIcon aria-hidden={true} className={className} />;
  }
}

const DirectoryRow = memo(function DirectoryRow({
  item,
  onOpen,
}: {
  item: DirectoryItem;
  onOpen: (item: DirectoryItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const timestamp = "endedAt" in item ? item.endedAt : item.startedAt;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={() => onOpen(item)}
    >
      <span className="mt-0.5 text-foreground-subtle">
        <StatusIcon status={item.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">
            {item.title}
          </span>
          <span className="shrink-0 text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({
              id: `subagentDirectory.status.${item.status}`,
            })}
          </span>
        </span>
        {item.summary ? (
          <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
            {item.summary}
          </span>
        ) : null}
      </span>
      {timestamp ? (
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">
          {formatTaskRelativeTime(timestamp, intl)}
        </span>
      ) : null}
    </button>
  );
});

export const SubagentDirectorySidePane = memo(
  function SubagentDirectorySidePane({
    tab,
    onOpenSubagentSession,
  }: {
    tab: SubagentDirectorySidePaneTab;
    onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  }) {
    const scope = useMemo<PaneWorkspaceScope>(
      () => ({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity
          ? { workspaceIdentity: tab.workspaceIdentity }
          : {}),
        ...(tab.remoteSessionId
          ? { remoteSessionId: tab.remoteSessionId }
          : {}),
      }),
      [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
    );
    return (
      <V4PaneConversationProvider scope={scope}>
        <SubagentDirectoryContents
          tab={tab}
          onOpenSubagentSession={onOpenSubagentSession}
        />
      </V4PaneConversationProvider>
    );
  },
);

const SubagentDirectoryContents = memo(function SubagentDirectoryContents({
  tab,
  onOpenSubagentSession,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  const subagents = projection.snapshot?.subagents;
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const directory = useSessionSubagents({
    enabled: projection.snapshot !== null,
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: tab.remoteSessionId,
    sessionId: tab.parentSessionId,
    refreshKey: subagents?.revision ?? 0,
  });
  const running = subagents?.running ?? EMPTY_RUNNING;
  const endedTotal = subagents?.endedTotal ?? 0;
  const handleOpen = (item: DirectoryItem) => {
    onOpenSubagentSession(buildSubagentDirectoryOpenRequest(tab, item));
  };

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "subagentDirectory.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <section>
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.running" })} ·{" "}
            {running.length}
          </h3>
          {running.length > 0 ? (
            running.map((item) => (
              <DirectoryRow
                key={item.childSessionId}
                item={item}
                onOpen={handleOpen}
              />
            ))
          ) : (
            <p className="px-3 py-3 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "subagentDirectory.runningEmpty" })}
            </p>
          )}
        </section>

        <section className="mt-5">
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.ended" })} ·{" "}
            {endedTotal}
          </h3>
          {directory.ended.items.map((item) => (
            <DirectoryRow
              key={item.childSessionId}
              item={item}
              onOpen={handleOpen}
            />
          ))}
          {directory.ended.nextCursor ? (
            <div className="px-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={directory.loading}
                onClick={() => void directory.loadMore()}
              >
                {intl.formatMessage({ id: "subagentDirectory.showMore" })}
              </Button>
            </div>
          ) : null}
        </section>

        {directory.error ? (
          <p
            role="alert"
            className="mx-3 mt-4 text-ui-sm text-[var(--color-danger)]"
          >
            {intl.formatMessage({ id: "subagentDirectory.loadFailed" })}
          </p>
        ) : null}
      </div>
    </div>
  );
});
