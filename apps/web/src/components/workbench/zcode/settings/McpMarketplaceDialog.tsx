import type {
  HostMcpMarketplaceServer,
  HostMcpMarketplaceSnapshot,
  IPlatformService,
} from "@zcode/shared";
import { Badge } from "@zui/components/ui/badge.js";
import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { Input } from "@zui/components/ui/input.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type McpMarketplace = NonNullable<IPlatformService["mcpMarketplace"]>;

/** 输入停止后延迟这么久再筛选，避免每敲一个字符重排整表。 */
const FILTER_DEBOUNCE_MS = 200;
/** 首次读取没读完时，按这个间隔问一次进度。 */
const PROGRESS_POLL_MS = 1_500;

/**
 * Claude Code 官方市场的 MCP 服务。
 *
 * 服务随插件分发（`.mcp.json` / `plugin.json`），服务端读完一份快照要十几秒，
 * 所以首次打开按进度轮询；读完是完整结果，刷新期间继续显示上一次的结果。
 * 添加时要填的变量（密钥、地址等）在条目上现场填，填齐才能添加。
 */
export function McpMarketplaceDialog({
  open,
  onOpenChange,
  marketplace,
  installedNames,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: McpMarketplace;
  /** 已存在的 server 名（显示「已添加」）。 */
  installedNames: ReadonlySet<string>;
  /** 每添加成功一个服务调用一次，调用方据此刷新服务列表。 */
  onAdded: () => void;
}) {
  // 每次打开换一个 key，内部状态（筛选词、填写值、添加进度）回到初始态
  const [openCount, setOpenCount] = useState(0);
  useEffect(() => {
    if (open) setOpenCount((count) => count + 1);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(84vh,640px)] max-h-[calc(100vh-2rem)] max-w-2xl overflow-hidden rounded-2xl p-0">
        {open ? (
          <MarketplaceBody
            key={openCount}
            marketplace={marketplace}
            installedNames={installedNames}
            onAdded={onAdded}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MarketplaceBody({
  marketplace,
  installedNames,
  onAdded,
}: {
  marketplace: McpMarketplace;
  installedNames: ReadonlySet<string>;
  onAdded: () => void;
}) {
  const { intl } = useZCodeIntl();
  const market = useMarketplaceSnapshot(marketplace);
  const addState = useMarketplaceAdd(marketplace, onAdded);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setFilter(query), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const visible = useMemo(
    () => filterServers(market.servers, filter),
    [filter, market.servers],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-5">
        <DialogHeader className="shrink-0 sm:-mt-1">
          <div className="flex items-center justify-between gap-2 pr-8">
            <DialogTitle className="flex min-w-0 items-center text-ui-lg">
              <span className="min-w-0 truncate">
                {intl.formatMessage({ id: "settings.mcp.marketplace.title" })}
              </span>
            </DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({
                id: "settings.mcp.marketplace.refresh",
              })}
              disabled={market.loading}
              onClick={market.refresh}
            >
              {market.loading ? (
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-3" aria-hidden="true" />
              )}
            </Button>
          </div>
        </DialogHeader>

        <div className="relative shrink-0">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground-subtlest"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.mcp.marketplace.searchPlaceholder",
            })}
            aria-label={intl.formatMessage({
              id: "settings.mcp.marketplace.searchPlaceholder",
            })}
            className="pl-8"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
          <div className="h-full overflow-auto p-3">
            <MarketplaceContent
              market={market}
              visible={visible}
              addState={addState}
              installedNames={installedNames}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 市场快照：首次读取一直在进行中就按间隔轮询；读完（或失败）停止。
 * 状态全部来自服务端的真实进度，不在这里编造。
 */
function useMarketplaceSnapshot(marketplace: McpMarketplace) {
  const [snapshot, setSnapshot] = useState<HostMcpMarketplaceSnapshot | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (refresh: boolean) => {
      const requestId = ++requestIdRef.current;
      try {
        const next = await marketplace.read(refresh ? { refresh: true } : {});
        if (requestId !== requestIdRef.current) return;
        setSnapshot(next);
        setFailed(false);
      } catch {
        if (requestId !== requestIdRef.current) return;
        setFailed(true);
      }
    },
    [marketplace],
  );

  const reading = snapshot === null || snapshot.state === "loading";
  useEffect(() => {
    void load(false);
  }, [load]);
  useEffect(() => {
    if (!reading) return;
    const timer = window.setInterval(() => void load(false), PROGRESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, reading]);
  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  const servers = snapshot?.servers ?? [];
  return {
    servers,
    snapshot,
    failed,
    loading: reading && !failed,
    refresh: () => void load(true),
  };
}

function filterServers(
  servers: readonly HostMcpMarketplaceServer[],
  query: string,
): readonly HostMcpMarketplaceServer[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return servers;
  return servers.filter((server) => {
    const haystack = [
      server.serverName,
      server.pluginTitle,
      server.plugin,
      server.description,
      server.category ?? "",
      server.author ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** 添加一个服务：记录进行中、添加成功与添加失败的条目 id。 */
function useMarketplaceAdd(marketplace: McpMarketplace, onAdded: () => void) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [addFailed, setAddFailed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [addedHere, setAddedHere] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const add = useCallback(
    async (input: Parameters<McpMarketplace["add"]>[0]): Promise<boolean> => {
      const identity = input.id;
      setBusy((previous) => new Set(previous).add(identity));
      setAddFailed((previous) => {
        const next = new Set(previous);
        next.delete(identity);
        return next;
      });
      try {
        // 此前已添加过的也通知调用方刷新：服务列表与市场状态以此保持一致
        await marketplace.add(input);
        setAddedHere((previous) => new Set(previous).add(identity));
        onAdded();
        return true;
      } catch {
        setAddFailed((previous) => new Set(previous).add(identity));
        return false;
      } finally {
        setBusy((previous) => {
          const next = new Set(previous);
          next.delete(identity);
          return next;
        });
      }
    },
    [marketplace, onAdded],
  );

  return { busy, addFailed, addedHere, add };
}

function MarketplaceContent({
  market,
  visible,
  addState,
  installedNames,
}: {
  market: ReturnType<typeof useMarketplaceSnapshot>;
  visible: readonly HostMcpMarketplaceServer[];
  addState: ReturnType<typeof useMarketplaceAdd>;
  installedNames: ReadonlySet<string>;
}) {
  const { intl } = useZCodeIntl();
  const snapshot = market.snapshot;

  if (market.failed && !snapshot) {
    return (
      <MarketplaceUnavailable
        message={intl.formatMessage({
          id: "settings.mcp.marketplace.unavailable",
        })}
        onRetry={market.refresh}
      />
    );
  }
  if (snapshot === null)
    return (
      <LoadingRow
        label={intl.formatMessage({ id: "settings.mcp.marketplace.loading" })}
      />
    );
  if (snapshot.state === "loading") {
    return (
      <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 rounded-lg bg-surface px-4 py-10 text-ui-base text-foreground-subtle">
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {intl.formatMessage(
            { id: "settings.mcp.marketplace.reading" },
            {
              checked: String(snapshot.checked),
              total: String(snapshot.total),
            },
          )}
        </span>
        {visible.length > 0 ? (
          <span className="text-ui-sm">
            {intl.formatMessage({ id: "settings.mcp.marketplace.partial" })}
          </span>
        ) : null}
      </div>
    );
  }
  if (snapshot.state === "failed") {
    return (
      <MarketplaceUnavailable
        message={
          snapshot.message ??
          intl.formatMessage({ id: "settings.mcp.marketplace.unavailable" })
        }
        onRetry={market.refresh}
      />
    );
  }
  if (visible.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.mcp.marketplace.empty" })}
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {snapshot.refreshing ? (
        <li className="mb-2 rounded-lg bg-surface px-3 py-1.5 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.mcp.marketplace.stale" })}
        </li>
      ) : null}
      {visible.map((server) => (
        <MarketplaceItem
          key={server.id}
          server={server}
          addState={addState}
          installed={installedNames.has(server.suggestedName)}
        />
      ))}
    </ul>
  );
}

function MarketplaceItem({
  server,
  addState,
  installed,
}: {
  server: HostMcpMarketplaceServer;
  addState: ReturnType<typeof useMarketplaceAdd>;
  installed: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [values, setValues] = useState<Record<string, string>>({});
  const isBusy = addState.busy.has(server.id);
  const isAdded = installed || addState.addedHere.has(server.id);
  const missingRequired = server.inputs.some(
    (input) =>
      input.required && !(values[input.name] ?? input.default ?? "").trim(),
  );
  return (
    <li
      data-testid="mcp-marketplace-item"
      className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-hover"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {server.serverName}
          </span>
          <KindBadge kind={server.kind} />
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
            {server.pluginTitle}
          </span>
        </div>
        {server.description ? (
          <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
            {server.description}
          </p>
        ) : null}
        {server.addable && server.inputs.length > 0 && !isAdded ? (
          <div className="mt-2 flex flex-col gap-1.5">
            {server.inputs.map((input) => (
              <div
                key={input.name}
                className="flex flex-wrap items-center gap-2 text-ui-sm text-foreground-subtle"
              >
                <span className="shrink-0">
                  {input.label}
                  {input.required ? (
                    <span className="text-destructive"> *</span>
                  ) : null}
                </span>
                <Input
                  type={input.secret ? "password" : "text"}
                  autoComplete={input.secret ? "off" : "on"}
                  value={values[input.name] ?? input.default ?? ""}
                  onChange={(event) =>
                    setValues((previous) => ({
                      ...previous,
                      [input.name]: event.target.value,
                    }))
                  }
                  aria-label={input.label}
                  placeholder={input.description ?? input.name}
                  className="h-7 w-full max-w-72 text-ui-sm"
                />
              </div>
            ))}
          </div>
        ) : null}
        {!server.addable && server.unsupportedReason ? (
          <p className="mt-0.5 text-ui-sm text-foreground-subtle">
            {server.unsupportedReason}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {addState.addFailed.has(server.id) ? (
          <span className="text-ui-sm text-destructive">
            {intl.formatMessage({ id: "settings.mcp.marketplace.addFailed" })}
          </span>
        ) : null}
        {isAdded ? (
          <span
            className="px-2 text-ui-sm text-foreground-subtle"
            data-testid="mcp-marketplace-installed"
          >
            {intl.formatMessage({ id: "settings.mcp.marketplace.installed" })}
          </span>
        ) : server.addable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy || missingRequired}
            onClick={() =>
              void addState.add({
                id: server.id,
                name: server.suggestedName,
                values,
              })
            }
          >
            {isBusy ? (
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({
              id: isBusy
                ? "settings.mcp.marketplace.adding"
                : "settings.mcp.marketplace.add",
            })}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function KindBadge({ kind }: { kind: "stdio" | "http" }) {
  const { intl } = useZCodeIntl();
  return (
    <Badge
      variant="outline"
      className="h-5 border-border bg-surface px-1.5 font-normal text-ui-xs text-foreground-subtle"
    >
      {intl.formatMessage({
        id:
          kind === "stdio"
            ? "settings.mcp.marketplace.kindLocal"
            : "settings.mcp.marketplace.kindRemote",
      })}
    </Badge>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-48 items-center justify-center gap-2 rounded-lg bg-surface px-4 py-10 text-ui-base text-foreground-subtle">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

function MarketplaceUnavailable({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 rounded-lg bg-surface px-4 py-10 text-center text-ui-base text-foreground-subtle">
      <span className="break-words">{message}</span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="size-3" aria-hidden="true" />
        {intl.formatMessage({ id: "settings.mcp.marketplace.retry" })}
      </Button>
    </div>
  );
}
