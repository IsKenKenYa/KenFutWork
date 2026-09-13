"use client";

import {
  BarChart3,
  Bot,
  Code2,
  Folder,
  Layers,
  Palette,
  Plug,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getServerBaseUrl } from "@/lib/env";

interface PluginEntry {
  name: string;
  title: string;
  description: string;
  system: boolean;
  installed: boolean;
}

async function togglePlugin(
  name: string,
  action: "install" | "uninstall",
  setPlugins: React.Dispatch<React.SetStateAction<PluginEntry[]>>,
) {
  const res = await fetch(
    `${getServerBaseUrl()}/api/plugins/${name}/${action}`,
    {
      method: "POST",
    },
  );
  if (res.ok) {
    const { installed } = (await res.json()) as { installed: boolean };
    setPlugins((prev) =>
      prev.map((p) => (p.name === name ? { ...p, installed } : p)),
    );
  }
}

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
};

type MarketTab = "discover" | "installed";

/**
 * 插件市场（模态）：发现/已安装 + 搜索。
 * 数据来自 GET /api/plugins（服务端真实装配清单，装配即已安装）。
 */
export function PluginMarketModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<MarketTab>("discover");
  const [query, setQuery] = useState("");
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`${getServerBaseUrl()}/api/plugins`)
      .then((r) => (r.ok ? r.json() : { plugins: [] }))
      .then((data: { plugins: PluginEntry[] }) => setPlugins(data.plugins))
      .catch(() => setPlugins([]))
      .finally(() => setLoading(false));
  }, [open]);

  // 当前装配清单内的插件均为已安装状态，发现/已安装共用同一列表，仅空态文案不同
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return plugins;
    return plugins.filter(
      (p) =>
        p.title.toLowerCase().includes(keyword) ||
        p.name.toLowerCase().includes(keyword) ||
        p.description.toLowerCase().includes(keyword),
    );
  }, [plugins, query]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex h-[75vh] max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        aria-describedby={undefined}
      >
        {/* 顶栏：标题 + 发现/已安装 + 搜索 */}
        <div className="flex items-center gap-3 border-b px-5 py-3 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base font-medium">
            <Layers className="h-4 w-4" /> 插件市场
          </DialogTitle>
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
            {(
              [
                { id: "discover", label: "发现" },
                { id: "installed", label: "已安装" },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                data-active={tab === t.id}
                onClick={() => setTab(t.id)}
                className="rounded-md px-3 py-1 text-sm transition-colors data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:shadow-sm"
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 rounded-md border px-2 py-1">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              aria-label="搜索插件"
              placeholder="搜索插件…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-40 bg-transparent text-sm outline-none"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {tab === "installed" ? "暂无已安装插件" : "未找到匹配的插件"}
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {filtered.map((p) => {
                const Icon = ICONS[p.name] ?? Plug;
                return (
                  <li
                    key={p.name}
                    className="flex items-start gap-3 rounded-xl border p-4"
                  >
                    <span className="rounded-lg bg-muted p-2">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{p.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {p.description}
                      </p>
                      <code className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px]">
                        {p.name}
                      </code>
                    </div>
                    {p.system ? (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        系统
                      </span>
                    ) : p.installed ? (
                      <button
                        type="button"
                        onClick={() => {
                          void togglePlugin(p.name, "uninstall", setPlugins);
                        }}
                        className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        卸载
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          void togglePlugin(p.name, "install", setPlugins);
                        }}
                        className="shrink-0 rounded-full bg-primary px-2.5 py-0.5 text-xs text-primary-foreground"
                      >
                        安装
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
