import {
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_MCP_SERVER_ROW,
  testId,
  type McpServerStatus,
  type ZCodeMcpServer,
} from "@zcode/shared";
import { Button } from "@zui/components/ui/button.js";
import { Switch } from "@zui/components/ui/switch.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@zui/ControlHintTooltip.js";
import { settingsResourceRowInteraction } from "@zui/settings/settingsResourceRowInteraction.js";
import { SettingsScopeBadge } from "@zui/settings/SettingsScopeBadge.js";
import {
  McpFailurePresentation,
  resolveMcpFailureMessageId,
} from "@zui/settings/McpFailurePresentation.js";
import { SettingsResourceList } from "@zui/settings/SettingsResourceGroup.js";
import { runUserAction } from "@zui/lib/userActionTelemetry.js";
import { CircleIcon, Cable, Loader2Icon, ExternalLink, Plus } from "lucide-react";

export function McpStatusDot({
  status,
  attention = false,
  disabled = false,
  reason,
}: {
  status?: McpServerStatus;
  attention?: boolean;
  disabled?: boolean;
  reason: string;
}) {
  const color = disabled
    ? "text-foreground-subtlest"
    : status === "connected"
      ? "text-green-500"
      : status === "connecting"
        ? "text-yellow-500"
        : status === "error"
          ? "text-red-500"
          : attention
            ? "text-yellow-500"
            : "text-foreground-subtlest";

  const icon =
    !disabled && status === "connecting" ? (
      <Loader2Icon className={`size-3 shrink-0 animate-spin ${color}`} aria-hidden="true" />
    ) : (
      <CircleIcon className={`size-2.5 shrink-0 fill-current ${color}`} aria-hidden="true" />
    );

  return (
    <ControlHintTooltip title={reason} className="max-w-64">
      <span className="inline-flex cursor-help items-center">{icon}</span>
    </ControlHintTooltip>
  );
}

function ScopeBadge({ scope }: { scope?: string }) {
  const normalizedScope = scope === "workspace" ? "workspace" : "user";
  return <SettingsScopeBadge scope={normalizedScope} includeMcpTestAttribute />;
}

function McpServerItem({
  server,
  onEdit,
  onToggle,
  onOpenAuthorization,
  hideMetadata,
}: {
  server: ZCodeMcpServer;
  onEdit: (server: ZCodeMcpServer) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenAuthorization?: (server: ZCodeMcpServer) => void;
  hideMetadata: boolean;
}) {
  const { intl } = useZCodeIntl();
  const typeLabel = server.config.command
    ? "stdio"
    : (server.config.type ?? (server.config.url ? "http" : "?"));
  const canEdit = server.origin !== "env" && (!server.location || server.location.source === "zcode");
  const canOpenAuthorization = Boolean(server.authorization?.authorizationUrl);
  const openAuthorizationLabel = intl.formatMessage({
    id: "settings.mcp.oauth.openAuthorization",
  });
  const statusReason = intl.formatMessage({
    id:
      server.status === "error"
        ? resolveMcpFailureMessageId(server.failureKind)
        : server.status === "connected"
          ? "settings.mcp.status.connectedReason"
          : server.status === "connecting"
            ? "settings.mcp.status.connectingReason"
            : server.status === "disconnected"
              ? "settings.mcp.status.disconnectedReason"
              : "settings.mcp.status.unknownReason",
  });

  const description = server.config.url
    ? `${typeLabel} · ${server.config.url}`
    : server.config.command
      ? `${typeLabel} · ${server.config.command} ${(server.config.args ?? []).join(" ")}`
      : typeLabel;

  return (
    <div
      className={`grid cursor-default grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors ${canEdit ? "hover:bg-hover" : ""}`}
      {...settingsResourceRowInteraction(canEdit ? () => onEdit(server) : undefined)}
      data-mcp-status={server.status ?? ""}
      data-mcp-tool-count={server.toolCount}
      data-testid={testId(TID_MCP_SERVER_ROW, server.name)}
    >
      <div
        className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
        data-mcp-status-dot-placement="icon-corner"
      >
        <Cable className="size-4" aria-hidden="true" />
        <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background">
          <McpStatusDot status={server.status} reason={statusReason} />
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{server.name}</span>
          {server.origin === "env" ? <span className="text-ui-sm text-foreground-subtle">只读</span> : null}
          {!hideMetadata ? <ScopeBadge scope={server.scope} /> : null}
          {!hideMetadata && typeof server.toolCount === "number" && (
            <span className="inline-flex rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border">
              {intl.formatMessage(
                { id: "settings.mcp.status.toolCount" },
                { count: String(server.toolCount) },
              )}
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-ui-sm text-foreground-subtle">{description}</div>
        {server.status === "error" ? (
          <McpFailurePresentation error={server.error} failureKind={server.failureKind} />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canOpenAuthorization && (
          <Button
            variant="link"
            size="sm"
            className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
            aria-label={openAuthorizationLabel}
            data-testid={testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, server.name)}
            title={openAuthorizationLabel}
            onClick={() =>
              runUserAction({
                input: { featureId: "extension.mcp", action: "authorize", trigger: "button" },
                operation: () => onOpenAuthorization?.(server),
                completed: { resultSource: "platform_result" },
                failureStage: "mcp_authorize",
              })
            }
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{openAuthorizationLabel}</span>
          </Button>
        )}
        <Switch disabled={server.origin === "env"} checked={server.enabled} onCheckedChange={(v) => onToggle(server.id, v)} />
      </div>
    </div>
  );
}

export function McpServerList({
  servers,
  onCreate,
  onEdit,
  onToggle,
  onOpenAuthorization,
  emptyTitle,
  emptyDescription,
  hideMetadata = false,
}: {
  servers: ZCodeMcpServer[];
  onCreate: () => void;
  onEdit: (server: ZCodeMcpServer) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenAuthorization?: (server: ZCodeMcpServer) => void;
  emptyTitle: string;
  emptyDescription: string;
  hideMetadata?: boolean;
}) {
  const { intl } = useZCodeIntl();

  if (servers.length === 0) {
    return (
      <div className="overflow-hidden rounded-xl border border-dashed border-border">
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
          <div className="space-y-1">
            <div className="text-ui-base font-medium text-foreground">{emptyTitle}</div>
            <div className="text-ui-base text-foreground-subtle">{emptyDescription}</div>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <Plus className="size-4" />
            <span>{intl.formatMessage({ id: "settings.mcp.create.open" })}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SettingsResourceList
      items={servers}
      getKey={(server) => server.id}
      renderItem={(server) => (
        <McpServerItem
          server={server}
          onEdit={onEdit}
          onToggle={onToggle}
          onOpenAuthorization={onOpenAuthorization}
          hideMetadata={hideMetadata}
        />
      )}
    />
  );
}
