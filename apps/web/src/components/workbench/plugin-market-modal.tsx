"use client";

import type { PluginMarketEntry } from "@kenfutwork/shared";
import {
  BarChart3,
  Bot,
  Code2,
  Folder,
  Layers,
  Palette,
  Plug,
  Search,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getServerBaseUrl } from "@/lib/env";
import { PluginIcon } from "@/lib/plugin-panels";
import { ListEmpty, ListLoading } from "./list-state";
import { PluginExportDialog } from "./plugin-export-dialog";
import { PluginInstallByUrl } from "./plugin-install-by-url";
import { PluginInstallFromWorkdir } from "./plugin-install-from-workdir";

const ICONS: Record<
  string,
  React.ComponentType<React.SVGProps<SVGSVGElement>>
> = {
  "model-providers": Plug,
  "agent-runs": Bot,
  permissions: ShieldCheck,
  "agent-modes": Code2,
  search: Search,
  mcp: Server,
  usage: BarChart3,
  canvas: Palette,
  skills: Folder,
  "plugin-registry": Layers,
};

type MarketTab = "discover" | "installed";

/**
 * 插件市场（模态）：发现 / 已安装 + 搜索 + 从链接安装 + 导出。
 * 数据来自 GET /api/plugins（内置清单 + 已安装插件）；第三方插件的变更端点需管理员。
 */
/**
 * 「使用」能跳到哪儿：**显式表**，只列真有消费界面的插件。
 * 不在表里的已装插件不给「使用」——宁可只显示安装态，也不放一个点了没反应的键。
 */
const USABLE_PLUGINS = new Set([
  "search", // 联网搜索 → 设置 → 浏览器 → 默认搜索引擎（消费方在那里）
  "mcp", // MCP 接入 → MCP 面板
  "skills", // 技能 → 技能面板
  "model-providers", // BYOK 供应商 → 设置 → 供应商
  "plugin-registry", // 插件市场 → 设置 → 插件面板
  "canvas", // 画布（Design）→ 切到 Design 模式
]);

export function PluginMarketModal({
  open,
  onClose,
  accessToken,
  canvasId = null,
  isAdmin = false,
  onUse,
}: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
  /** 当前工作目录的画布 id（「从工作目录安装」用）。 */
  canvasId?: string | null;
  /** 安装端点要管理员：非管理员时两个安装入口都前置说明并禁用。 */
  isAdmin?: boolean;
  /**
   * 「使用」：已装的插件跳到**真正消费它的那个界面**（参考图里已装插件显示「使用」而不是「安装」）。
   * 没给回调时按「这个插件没有可跳的界面」处理——不摆一个点了没反应的键。
   */
  onUse?: ((pluginName: string) => void) | undefined;
}) {
  const [tab, setTab] = useState<MarketTab>("discover");
  /** 切页签重置滚动位置（与设置/MCP/技能弹窗同款交互修正）。 */
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  /** 分类筛选（null = 全部）。分类来自清单的 `category`（第三方在 package.json 声明）。 */
  const [category, setCategory] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<PluginMarketEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportName, setExportName] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const toast = useToast();

  const authHeaders = useCallback(
    (): Record<string, string> =>
      accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    [accessToken],
  );

  const refresh = useCallback(() => {
    setLoading(true);
    void fetch(`${getServerBaseUrl()}/api/plugins`, { headers: authHeaders() })
      .then((response) => (response.ok ? response.json() : { plugins: [] }))
      .then((data: { plugins: PluginMarketEntry[] }) =>
        setPlugins(data.plugins),
      )
      .catch(() => setPlugins([]))
      .finally(() => setLoading(false));
  }, [authHeaders]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  async function toggle(entry: PluginMarketEntry) {
    setNotice(null);
    // 自带而未装的插件：直接装（市场一键，无需找来源链接）；安装端点不带插件 id
    const installingBuiltin = entry.source === "builtin" && !entry.installed;
    const url = entry.installed
      ? `${getServerBaseUrl()}/api/plugins/${encodeURIComponent(entry.id)}/uninstall`
      : installingBuiltin
        ? `${getServerBaseUrl()}/api/plugins/install`
        : `${getServerBaseUrl()}/api/plugins/${encodeURIComponent(entry.id)}/toggle`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(
        entry.installed
          ? {}
          : installingBuiltin
            ? { builtin: entry.name }
            : { enabled: true },
      ),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      toast.error(
        payload.error?.message ??
          "操作失败（变更类操作需要管理员权限，可在设置 → 管理后台调整）。",
      );
      return;
    }
    toast.success(entry.installed ? "已卸载。" : "已安装。");
    refresh();
  }

  /**
   * 分类 chips 的取值：**只列清单里真有的分类**（不摆空 chip），顺序按下面这张偏好表，
   * 表外的分类排在后面并按名称排序——第三方插件自带分类时也是这个规则。
   */
  const categories = useMemo(() => {
    const preferred = [
      "模型与供应商",
      "Agent 能力",
      "工具与集成",
      "创作与画布",
      "数据与统计",
      "系统",
    ];
    const present = new Set(
      plugins
        .map((entry) => entry.category)
        .filter((c): c is string => Boolean(c)),
    );
    return [
      ...preferred.filter((c) => present.has(c)),
      ...[...present].filter((c) => !preferred.includes(c)).sort(),
      ...(plugins.some((entry) => !entry.category) ? ["其他"] : []),
    ];
  }, [plugins]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    // 发现 = 全部可发现项；已安装 = 已装 + 系统项（内置插件恒为已装）
    const byTab = plugins.filter((entry) =>
      tab === "installed" ? entry.installed || entry.system : true,
    );
    const byCategory =
      category === null
        ? byTab
        : byTab.filter((entry) =>
            category === "其他" ? !entry.category : entry.category === category,
          );
    if (!keyword) return byCategory;
    return byCategory.filter(
      (entry) =>
        entry.title.toLowerCase().includes(keyword) ||
        entry.name.toLowerCase().includes(keyword) ||
        entry.description.toLowerCase().includes(keyword),
    );
  }, [plugins, query, tab, category]);

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent
          className="flex h-[78vh] max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
          aria-describedby={undefined}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3 pr-12">
            <DialogTitle className="flex shrink-0 items-center gap-2 text-base font-medium">
              <Layers className="h-4 w-4" /> 插件市场
            </DialogTitle>
            <div className="flex shrink-0 items-center gap-1 rounded-lg bg-muted p-1">
              {(
                [
                  { id: "discover", label: "发现" },
                  { id: "installed", label: "已安装" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-active={tab === item.id}
                  onClick={() => {
                    setTab(item.id);
                    if (contentRef.current) contentRef.current.scrollTop = 0;
                  }}
                  className="whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:shadow-sm"
                >
                  {item.label}
                </button>
              ))}
            </div>
            {/* 「管理」入口：装完的插件在这里启停/卸载/导出（参考图右上角那个键） */}
            <button
              type="button"
              onClick={() => {
                setTab("installed");
                setNotice("在这里启停、卸载或导出已安装的插件。");
              }}
              className="ml-auto shrink-0 rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              管理
            </button>
            <div className="flex shrink-0 items-center gap-2 rounded-md border px-2 py-1">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                aria-label="搜索插件"
                placeholder="搜索插件…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-40 bg-transparent text-sm outline-none"
              />
            </div>
          </div>

          {categories.length > 0 ? (
            <fieldset
              aria-label="插件分类"
              className="flex min-w-0 flex-wrap items-center gap-1.5 border-b px-5 py-2"
            >
              {[null, ...categories].map((item) => (
                <button
                  key={item ?? "全部"}
                  type="button"
                  data-active={category === item}
                  onClick={() => setCategory(item)}
                  className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground data-[active=true]:border-foreground/40 data-[active=true]:bg-muted data-[active=true]:font-medium data-[active=true]:text-foreground"
                >
                  {item ?? "全部"}
                </button>
              ))}
            </fieldset>
          ) : null}

          <div
            ref={contentRef}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
          >
            {tab === "discover" ? (
              <>
                <PluginInstallByUrl
                  accessToken={accessToken}
                  isAdmin={isAdmin}
                  onInstalled={refresh}
                />
                <PluginInstallFromWorkdir
                  accessToken={accessToken}
                  canvasId={canvasId}
                  isAdmin={isAdmin}
                  onInstalled={refresh}
                />
              </>
            ) : null}

            {notice ? (
              <p className="text-xs text-destructive">{notice}</p>
            ) : null}

            {loading ? (
              <ListLoading label="正在加载插件…" rows={3} />
            ) : visible.length === 0 ? (
              <ListEmpty
                title={
                  tab === "installed" ? "暂无已安装插件" : "未找到匹配的插件"
                }
                {...(tab === "installed"
                  ? { hint: "可在「发现」里按来源链接安装。" }
                  : {})}
              />
            ) : (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {visible.map((entry) => {
                  const Icon = ICONS[entry.name] ?? Plug;
                  // 插件自带图标（ui[].icon）：已装（资产路由可用）或自带未装（注册表兜底）时用真图标
                  const iconPath =
                    entry.ui?.find((item) => item.icon)?.icon ?? null;
                  const showRealIcon =
                    iconPath !== null &&
                    (entry.installed || entry.source === "builtin");
                  return (
                    <li
                      key={`${entry.source}-${entry.id}`}
                      className="flex items-start gap-3 rounded-xl border p-4"
                    >
                      <span className="rounded-lg bg-muted p-2">
                        <PluginIcon
                          icon={showRealIcon ? iconPath : null}
                          pluginId={entry.id}
                          fallback={<Icon className="h-4 w-4" />}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{entry.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {entry.description}
                        </p>
                        <code className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px]">
                          {entry.source === "builtin" ? entry.name : entry.id}
                        </code>
                        {entry.category ? (
                          <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {entry.category}
                          </span>
                        ) : null}
                        {entry.headSha ? (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            @{entry.headSha.slice(0, 7)}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {entry.system ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            系统
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              void toggle(entry);
                            }}
                            className={
                              entry.installed
                                ? "rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                : "rounded-full bg-primary px-2.5 py-0.5 text-xs text-primary-foreground"
                            }
                          >
                            {entry.installed ? "卸载" : "安装"}
                          </button>
                        )}
                        {/* 已装且有可跳界面 → 「使用」（参考图口径）；系统插件本身就在界面上，不给 */}
                        {!entry.system &&
                        entry.installed &&
                        onUse &&
                        USABLE_PLUGINS.has(entry.name) ? (
                          <button
                            type="button"
                            onClick={() => onUse(entry.name)}
                            className="rounded-full bg-primary px-2.5 py-0.5 text-xs text-primary-foreground"
                          >
                            使用
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setExportName(entry.name)}
                          className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          导出
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <PluginExportDialog
        name={exportName}
        accessToken={accessToken}
        onClose={() => setExportName(null)}
      />
    </>
  );
}
