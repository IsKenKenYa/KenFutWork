import type {
  HostMcpCatalogItem,
  HostMcpMarketplaceItem,
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
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type McpMarketplace = NonNullable<IPlatformService["mcpMarketplace"]>;

/** 输入停止后延迟这么久再搜索，避免每敲一个字符发一次请求。 */
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 20;

/**
 * 从 MCP 市场添加服务：搜索框为空时展示内置精选目录（离线可用，需要参数的现场补齐），
 * 输入关键词后检索官方 MCP 注册表。添加成功后通知调用方刷新服务列表，
 * 对话框保持打开，方便连续添加多个。
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
  /** 服务列表里已经存在的名字。 */
  installedNames: ReadonlySet<string>;
  /** 每添加成功一个服务调用一次，调用方据此刷新服务列表。 */
  onAdded: () => void;
}) {
  // 每次打开换一个 key，内部状态（搜索词、目录、添加进度）自然回到初始态
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
  const search = useMarketplaceSearch(marketplace);
  const addState = useMarketplaceAdd(marketplace, onAdded);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-5">
        <DialogHeader className="shrink-0 sm:-mt-1">
          <DialogTitle className="flex min-w-0 items-center text-ui-lg">
            <span className="min-w-0 truncate">
              {intl.formatMessage({ id: "settings.mcp.marketplace.title" })}
            </span>
          </DialogTitle>
        </DialogHeader>

        <Input
          type="search"
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.mcp.marketplace.searchPlaceholder",
          })}
          aria-label={intl.formatMessage({
            id: "settings.mcp.marketplace.searchPlaceholder",
          })}
          className="shrink-0"
        />

        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
          <div className="h-full overflow-auto p-3">
            {search.trimmedQuery === "" ? (
              <CatalogList
                load={marketplace.catalog}
                addState={addState}
                installedNames={installedNames}
              />
            ) : (
              <RegistryList
                search={search}
                addState={addState}
                installedNames={installedNames}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 注册表检索：维护搜索词、结果与首屏进行中 / 失败状态。 */
function useMarketplaceSearch(marketplace: McpMarketplace) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly HostMcpMarketplaceItem[]>([]);
  const [pending, setPending] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  /** 请求序号：只采用最后一次请求的结果，迟到的响应一律丢弃。 */
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (searchQuery: string) => {
      const requestId = ++requestIdRef.current;
      setPending(true);
      setSearchFailed(false);
      try {
        const result = await marketplace.search({
          query: searchQuery,
          limit: SEARCH_LIMIT,
        });
        if (requestId !== requestIdRef.current) return;
        setItems(result.items);
      } catch {
        if (requestId !== requestIdRef.current) return;
        setSearchFailed(true);
      } finally {
        if (requestId === requestIdRef.current) setPending(false);
      }
    },
    [marketplace],
  );

  const trimmedQuery = query.trim();
  const firstRunRef = useRef(true);
  useEffect(() => {
    // 空词不发检索请求（列表切回精选目录）；关键词停下后再搜
    if (trimmedQuery === "") {
      firstRunRef.current = false;
      requestIdRef.current += 1;
      setPending(false);
      setSearchFailed(false);
      return;
    }
    const timer = window.setTimeout(
      () => void load(trimmedQuery),
      firstRunRef.current ? 0 : SEARCH_DEBOUNCE_MS,
    );
    firstRunRef.current = false;
    return () => window.clearTimeout(timer);
  }, [trimmedQuery, load]);
  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  return { query, setQuery, trimmedQuery, items, pending, searchFailed, load };
}

/** 添加一个服务：记录进行中、添加成功与添加失败的名字。 */
function useMarketplaceAdd(marketplace: McpMarketplace, onAdded: () => void) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [addFailed, setAddFailed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [addedHere, setAddedHere] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const add = useCallback(
    async (
      input: Parameters<McpMarketplace["add"]>[0],
      identity: string,
    ): Promise<boolean> => {
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

/** 搜索框为空时的内置精选目录：加载一次，需要参数的条目现场补齐。 */
function CatalogList({
  load,
  addState,
  installedNames,
}: {
  load: () => Promise<readonly HostMcpCatalogItem[]>;
  addState: ReturnType<typeof useMarketplaceAdd>;
  installedNames: ReadonlySet<string>;
}) {
  const catalog = useCatalog(load);
  if (catalog.pending) return <LoadingRow fill />;
  if (catalog.failed) {
    return <MarketplaceUnavailable onRetry={catalog.reload} />;
  }
  if (catalog.items.length === 0) return <EmptyRow />;
  return (
    <ul className="flex flex-col">
      {catalog.items.map((item) => (
        <CatalogItemRow
          key={item.id}
          item={item}
          addState={addState}
          installed={installedNames.has(item.name)}
        />
      ))}
    </ul>
  );
}

function useCatalog(loader: () => Promise<readonly HostMcpCatalogItem[]>) {
  const [items, setItems] = useState<readonly HostMcpCatalogItem[]>([]);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    if (!loader) {
      setPending(false);
      setFailed(true);
      return;
    }
    setPending(true);
    setFailed(false);
    loader()
      .then((result) => {
        setItems(result);
        setPending(false);
      })
      .catch(() => {
        setFailed(true);
        setPending(false);
      });
  }, [loader]);
  useEffect(() => {
    load();
  }, [load]);
  return { items, pending, failed, reload: load };
}

function RegistryList({
  search,
  addState,
  installedNames,
}: {
  search: ReturnType<typeof useMarketplaceSearch>;
  addState: ReturnType<typeof useMarketplaceAdd>;
  installedNames: ReadonlySet<string>;
}) {
  const { pending, searchFailed } = search;
  if (pending) return <LoadingRow fill />;
  if (searchFailed) {
    return (
      <MarketplaceUnavailable
        onRetry={() => void search.load(search.trimmedQuery)}
      />
    );
  }
  if (search.items.length === 0) return <EmptyRow />;
  return (
    <ul className="flex flex-col">
      {search.items.map((item) => (
        <RegistryItemRow
          key={item.name}
          item={item}
          addState={addState}
          installed={installedNames.has(item.suggestedName)}
        />
      ))}
    </ul>
  );
}

function RegistryItemRow({
  item,
  addState,
  installed,
}: {
  item: HostMcpMarketplaceItem;
  addState: ReturnType<typeof useMarketplaceAdd>;
  installed: boolean;
}) {
  const { intl } = useZCodeIntl();
  // 已添加的判定用 server 名（suggestedName），添加身份用注册表规范名（name）
  const isBusy = addState.busy.has(item.name);
  const isAdded = installed || addState.addedHere.has(item.name);
  return (
    <li
      data-testid="mcp-marketplace-item"
      className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-hover"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {item.name}
          </span>
          <KindBadge kind={item.kind} />
        </div>
        {item.description ? (
          <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
            {item.description}
          </p>
        ) : null}
        {!item.installable && item.unsupportedReason ? (
          <p className="mt-0.5 text-ui-sm text-foreground-subtle">
            {item.unsupportedReason}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {addState.addFailed.has(item.name) ? (
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
        ) : item.installable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy}
            onClick={() =>
              void addState.add(
                {
                  name: item.suggestedName,
                  kind: item.kind,
                  ...(item.kind === "stdio"
                    ? {
                        command: item.suggestedCommand ?? undefined,
                        args: item.suggestedArgs,
                      }
                    : { url: item.suggestedUrl ?? undefined }),
                },
                item.name,
              )
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

/** 精选目录条目：参数占位符现场补齐，补齐后才能添加。 */
function CatalogItemRow({
  item,
  addState,
  installed,
}: {
  item: HostMcpCatalogItem;
  addState: ReturnType<typeof useMarketplaceAdd>;
  installed: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const isBusy = addState.busy.has(item.id);
  const isAdded = installed || addState.addedHere.has(item.id);
  const missingRequired = item.params.some(
    (param) => param.required && !paramValues[param.key]?.trim(),
  );
  const resolveArgs = () =>
    item.argsTemplate.map((template) => {
      const value = paramValues[template.slice(2, -2)]?.trim();
      // 非占位符的模板段原样保留；占位符有值就替换
      return /^\{\{\w+\}\}$/u.test(template) && value ? value : template;
    });
  return (
    <li
      data-testid="mcp-marketplace-item"
      className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-hover"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {item.title}
          </span>
          <Badge
            variant="outline"
            className="h-5 border-border bg-surface px-1.5 font-normal text-ui-xs text-foreground-subtle"
          >
            {intl.formatMessage({
              id:
                item.requires === "node"
                  ? "settings.mcp.marketplace.requiresNode"
                  : "settings.mcp.marketplace.requiresPython",
            })}
          </Badge>
        </div>
        {item.description ? (
          <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
            {item.description}
          </p>
        ) : null}
        {item.params.length > 0 && !isAdded ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {item.params.map((param) => (
              <div
                key={param.key}
                className="flex items-center gap-2 text-ui-sm text-foreground-subtle"
              >
                <span className="shrink-0">{param.label}</span>
                <Input
                  value={paramValues[param.key] ?? ""}
                  onChange={(event) =>
                    setParamValues((previous) => ({
                      ...previous,
                      [param.key]: event.target.value,
                    }))
                  }
                  placeholder={param.example}
                  aria-label={param.label}
                  className="h-7 w-56 text-ui-sm"
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {addState.addFailed.has(item.id) ? (
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
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy || missingRequired}
            onClick={() =>
              void addState.add(
                {
                  name: item.name,
                  kind: "stdio",
                  command: item.command,
                  args: resolveArgs(),
                },
                item.id,
              )
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
        )}
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

function LoadingRow({ fill = false }: { fill?: boolean }) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className={`flex items-center justify-center gap-2 rounded-lg bg-surface text-ui-base text-foreground-subtle ${
        fill ? "h-full min-h-48 px-4 py-10" : "px-4 py-4"
      }`}
    >
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {intl.formatMessage({ id: "settings.mcp.marketplace.loading" })}
    </div>
  );
}

function EmptyRow() {
  const { intl } = useZCodeIntl();
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "settings.mcp.marketplace.empty" })}
    </div>
  );
}

function MarketplaceUnavailable({ onRetry }: { onRetry: () => void }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 rounded-lg bg-surface px-4 py-10 text-ui-base text-foreground-subtle">
      <span>
        {intl.formatMessage({ id: "settings.mcp.marketplace.unavailable" })}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="size-3" aria-hidden="true" />
        {intl.formatMessage({ id: "settings.mcp.marketplace.retry" })}
      </Button>
    </div>
  );
}
