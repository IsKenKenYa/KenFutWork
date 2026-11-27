import { Loader2, RefreshCw } from "lucide-react";
import type {
  HostSkillMarketplaceItem,
  IPlatformService,
} from "@zcode/shared";
import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { Input } from "@zui/components/ui/input.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { useCallback, useEffect, useRef, useState } from "react";

type SkillMarketplace = NonNullable<IPlatformService["skillMarketplace"]>;

// 下面两个是只影响这个对话框观感的局部常量：页大小决定一次展示多少条、
// 延迟决定输入停顿多久才发请求，都不属于服务端治理表里的运行时可调数值。
/** 每页条数。 */
const PAGE_SIZE = 20;
/** 输入停止后延迟这么久再搜索，避免每敲一个字符发一次请求。 */
const SEARCH_DEBOUNCE_MS = 300;

type PageMode = "first" | "more";
type PageState<T extends PageMode> = "none" | T;

/**
 * 从技能市场添加技能。打开即浏览第一页，输入关键词后搜索；每个条目可单独添加，
 * 已经在技能列表里的（或本次刚添加的）显示「已添加」。添加成功后通知调用方刷新技能列表，
 * 对话框保持打开，方便连续添加多个。
 */
export function SkillMarketplaceDialog({
  open,
  onOpenChange,
  marketplace,
  installedPackageNames,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: SkillMarketplace;
  /** 技能列表里已经装上的市场包。 */
  installedPackageNames: ReadonlySet<string>;
  /** 每添加成功一个技能调用一次，调用方据此刷新技能列表。 */
  onInstalled: () => void;
}) {
  // 每次打开换一个 key，内部状态（搜索词、结果、添加进度）自然回到初始态
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
            installedPackageNames={installedPackageNames}
            onInstalled={onInstalled}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MarketplaceBody({
  marketplace,
  installedPackageNames,
  onInstalled,
}: {
  marketplace: SkillMarketplace;
  installedPackageNames: ReadonlySet<string>;
  onInstalled: () => void;
}) {
  const { intl } = useZCodeIntl();
  const search = useMarketplaceSearch(marketplace);
  const installState = useMarketplaceInstall(marketplace, onInstalled);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-5">
        <DialogHeader className="shrink-0 sm:-mt-1">
          <DialogTitle className="flex min-w-0 items-center text-ui-lg">
            <span className="min-w-0 truncate">
              {intl.formatMessage({ id: "settings.skills.marketplace.title" })}
            </span>
          </DialogTitle>
        </DialogHeader>

        <Input
          type="search"
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.skills.marketplace.searchPlaceholder",
          })}
          aria-label={intl.formatMessage({
            id: "settings.skills.marketplace.searchPlaceholder",
          })}
          className="shrink-0"
        />

        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
          <div className="h-full overflow-auto p-3">
            <MarketplaceList
              search={search}
              installState={installState}
              installedPackageNames={installedPackageNames}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** 技能市场的搜索与分页：维护搜索词、已加载的结果，以及首屏 / 追加页的进行中与失败状态。 */
function useMarketplaceSearch(marketplace: SkillMarketplace) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly HostSkillMarketplaceItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadedPages, setLoadedPages] = useState(0);
  const [pending, setPending] = useState<PageState<PageMode>>("none");
  const [searchFailed, setSearchFailed] =
    useState<PageState<PageMode>>("none");
  /** 请求序号：只采用最后一次请求的结果；关闭对话框或换了搜索词之后的迟到响应一律丢弃。 */
  const requestIdRef = useRef(0);

  const loadPage = useCallback(
    async (searchQuery: string, page: number, mode: PageMode) => {
      const requestId = ++requestIdRef.current;
      setPending(mode);
      setSearchFailed("none");
      try {
        const result = await marketplace.search({
          query: searchQuery,
          page,
          limit: PAGE_SIZE,
        });
        if (requestId !== requestIdRef.current) return;
        setItems((previous) =>
          mode === "more"
            ? mergeByPackageName(previous, result.skills)
            : result.skills,
        );
        // 带关键词时服务端先多取再过滤，total 是过滤前的数字，
        // 只能按「这一页还有没有结果」判断后面还有没有
        setHasMore(
          result.skills.length > 0 &&
            (searchQuery !== "" || page * PAGE_SIZE < result.total),
        );
        setLoadedPages(page);
      } catch {
        if (requestId !== requestIdRef.current) return;
        setSearchFailed(mode);
      } finally {
        if (requestId === requestIdRef.current) setPending("none");
      }
    },
    [marketplace],
  );

  const trimmedQuery = query.trim();
  const firstRunRef = useRef(true);
  useEffect(() => {
    // 打开立即浏览第一页；之后每次搜索词变化，等输入停下再搜
    const timer = window.setTimeout(
      () => void loadPage(trimmedQuery, 1, "first"),
      firstRunRef.current ? 0 : SEARCH_DEBOUNCE_MS,
    );
    firstRunRef.current = false;
    return () => window.clearTimeout(timer);
  }, [trimmedQuery, loadPage]);
  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  return {
    query,
    setQuery,
    trimmedQuery,
    items,
    hasMore,
    loadedPages,
    pending,
    searchFailed,
    loadPage,
  };
}

/** 追加页与已加载结果按包名合并，翻页区间重叠时不出现重复条目。 */
function mergeByPackageName(
  previous: readonly HostSkillMarketplaceItem[],
  incoming: readonly HostSkillMarketplaceItem[],
): readonly HostSkillMarketplaceItem[] {
  const known = new Set(previous.map((item) => item.packageName));
  return [
    ...previous,
    ...incoming.filter((item) => !known.has(item.packageName)),
  ];
}

/** 添加一个市场技能：记录进行中、添加成功与添加失败的包。 */
function useMarketplaceInstall(
  marketplace: SkillMarketplace,
  onInstalled: () => void,
) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [installFailed, setInstallFailed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [addedHere, setAddedHere] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const install = async (item: HostSkillMarketplaceItem) => {
    const packageName = item.packageName;
    setBusy((previous) => new Set(previous).add(packageName));
    setInstallFailed(togglePackage(packageName, false));
    try {
      // 此前已添加过的也通知调用方刷新：技能列表与市场状态以此保持一致
      await marketplace.install({ packageName });
      setAddedHere((previous) => new Set(previous).add(packageName));
      onInstalled();
    } catch {
      setInstallFailed(togglePackage(packageName, true));
    } finally {
      setBusy(togglePackage(packageName, false));
    }
  };

  return { busy, installFailed, addedHere, install };
}

function togglePackage(packageName: string, present: boolean) {
  return (previous: ReadonlySet<string>) => {
    const next = new Set(previous);
    if (present) next.add(packageName);
    else next.delete(packageName);
    return next;
  };
}

function MarketplaceList({
  search,
  installState,
  installedPackageNames,
}: {
  search: ReturnType<typeof useMarketplaceSearch>;
  installState: ReturnType<typeof useMarketplaceInstall>;
  installedPackageNames: ReadonlySet<string>;
}) {
  const { pending, searchFailed } = search;
  if (pending === "first") return <LoadingRow fill />;
  if (searchFailed === "first") {
    return (
      <MarketplaceUnavailable
        onRetry={() => void search.loadPage(search.trimmedQuery, 1, "first")}
      />
    );
  }
  if (search.items.length === 0) return <EmptyRow />;
  return (
    <>
      <ul className="flex flex-col">
        {search.items.map((item) => (
          <MarketplaceItemRow
            key={item.packageName}
            item={item}
            installState={installState}
            installed={installedPackageNames.has(item.packageName)}
          />
        ))}
      </ul>
      <MarketplaceListFooter search={search} />
    </>
  );
}

function MarketplaceListFooter({
  search,
}: {
  search: ReturnType<typeof useMarketplaceSearch>;
}) {
  const { pending, searchFailed } = search;
  if (pending === "more") return <LoadingRow />;
  if (searchFailed === "more") {
    return (
      <div className="flex items-center justify-center gap-3 px-4 py-4 text-ui-base text-foreground-subtle">
        <MarketplaceUnavailableLabel />
        <RetryButton
          onClick={() =>
            void search.loadPage(search.trimmedQuery, search.loadedPages + 1, "more")
          }
        />
      </div>
    );
  }
  if (!search.hasMore) return null;
  const { intl } = useZCodeIntl();
  return (
    <div className="flex justify-center px-4 py-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() =>
          void search.loadPage(search.trimmedQuery, search.loadedPages + 1, "more")
        }
      >
        {intl.formatMessage({ id: "settings.skills.marketplace.loadMore" })}
      </Button>
    </div>
  );
}

function MarketplaceItemRow({
  item,
  installState,
  installed,
}: {
  item: HostSkillMarketplaceItem;
  installState: ReturnType<typeof useMarketplaceInstall>;
  installed: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { busy, installFailed, addedHere, install } = installState;
  const isBusy = busy.has(item.packageName);
  const isInstalled = installed || addedHere.has(item.packageName);
  return (
    <li
      data-testid="skill-marketplace-item"
      className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-hover"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {item.name}
          </span>
          {item.author && item.author !== "unknown" ? (
            <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
              {item.author}
            </span>
          ) : null}
        </div>
        {item.description ? (
          <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
            {item.description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {installFailed.has(item.packageName) ? (
          <span className="text-ui-sm text-destructive">
            {intl.formatMessage({ id: "settings.skills.marketplace.installFailed" })}
          </span>
        ) : null}
        {isInstalled ? (
          <span
            className="px-2 text-ui-sm text-foreground-subtle"
            data-testid="skill-marketplace-installed"
          >
            {intl.formatMessage({ id: "settings.skills.marketplace.installed" })}
          </span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy}
            onClick={() => void install(item)}
          >
            {isBusy ? (
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({
              id: isBusy
                ? "settings.skills.marketplace.installing"
                : "settings.skills.marketplace.install",
            })}
          </Button>
        )}
      </div>
    </li>
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
      {intl.formatMessage({ id: "settings.skills.marketplace.loading" })}
    </div>
  );
}

function EmptyRow() {
  const { intl } = useZCodeIntl();
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "settings.skills.marketplace.empty" })}
    </div>
  );
}

function MarketplaceUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 rounded-lg bg-surface px-4 py-10 text-ui-base text-foreground-subtle">
      <MarketplaceUnavailableLabel />
      <RetryButton onClick={onRetry} />
    </div>
  );
}

function MarketplaceUnavailableLabel() {
  const { intl } = useZCodeIntl();
  return (
    <span>
      {intl.formatMessage({ id: "settings.skills.marketplace.unavailable" })}
    </span>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  const { intl } = useZCodeIntl();
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      <RefreshCw className="size-3" aria-hidden="true" />
      {intl.formatMessage({ id: "settings.skills.marketplace.retry" })}
    </Button>
  );
}
