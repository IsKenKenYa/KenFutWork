"use client";

import type { PluginMarketEntry } from "@kenfutwork/shared";
import {
  BarChart3,
  Bot,
  Code2,
  Download,
  Folder,
  Layers,
  Palette,
  Plug,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getServerBaseUrl } from "@/lib/env";
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
  mcp: Plug,
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
export function PluginMarketModal({
  open,
  onClose,
  accessToken,
  canvasId = null,
  isAdmin = false,
}: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
  /** 当前工作目录的画布 id（「从工作目录安装」用）。 */
  canvasId?: string | null;
  /** 安装端点要管理员：非管理员时两个安装入口都前置说明并禁用。 */
  isAdmin?: boolean;
}) {
  const [tab, setTab] = useState<MarketTab>("discover");
  const [query, setQuery] = useState("");
  const [plugins, setPlugins] = useState<PluginMarketEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportName, setExportName] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    const action = entry.installed ? "uninstall" : "toggle";
    const response = await fetch(
      `${getServerBaseUrl()}/api/plugins/${encodeURIComponent(entry.id)}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        ...(action === "toggle"
          ? { body: JSON.stringify({ enabled: true }) }
          : {}),
      },
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setNotice(
        payload.error?.message ?? "操作失败（变更类操作需要管理员权限）。",
      );
      return;
    }
    refresh();
  }

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    // 发现 = 全部可发现项；已安装 = 已装 + 系统项（内置插件恒为已装）
    const byTab = plugins.filter((entry) =>
      tab === "installed" ? entry.installed || entry.system : true,
    );
    if (!keyword) return byTab;
    return byTab.filter(
      (entry) =>
        entry.title.toLowerCase().includes(keyword) ||
        entry.name.toLowerCase().includes(keyword) ||
        entry.description.toLowerCase().includes(keyword),
    );
  }, [plugins, query, tab]);

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
                  onClick={() => setTab(item.id)}
                  className="whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:shadow-sm"
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2 rounded-md border px-2 py-1">
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

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
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
                  return (
                    <li
                      key={`${entry.source}-${entry.id}`}
                      className="flex items-start gap-3 rounded-xl border p-4"
                    >
                      <span className="rounded-lg bg-muted p-2">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{entry.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {entry.description}
                        </p>
                        <code className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px]">
                          {entry.source === "builtin" ? entry.name : entry.id}
                        </code>
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
                        <button
                          type="button"
                          onClick={() => setExportName(entry.name)}
                          className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Download className="h-3 w-3" /> 导出
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
