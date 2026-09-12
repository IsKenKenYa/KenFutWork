"use client";

import {
  BarChart3,
  Bot,
  ChevronLeft,
  Code2,
  Folder,
  Layers,
  Palette,
  Plug,
  Search,
  Settings,
  ShieldCheck,
} from "lucide-react";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getServerBaseUrl } from "@/lib/env";

interface PluginEntry {
  name: string;
  title: string;
  description: string;
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

/** 插件市场：展示当前真实装配的插件清单（GET /api/plugins）。 */
export default function PluginsPage() {
  const router = useRouter();
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${getServerBaseUrl()}/api/plugins`)
      .then((r) => (r.ok ? r.json() : { plugins: [] }))
      .then((data: { plugins: PluginEntry[] }) => setPlugins(data.plugins))
      .catch(() => setPlugins([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="返回工作台"
            onClick={() => router.push("/workbench")}
            className="rounded-md p-2 hover:bg-muted"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1 text-sm font-medium">
            <Layers className="h-4 w-4" /> 插件市场
          </div>
        </div>
        <button
          type="button"
          aria-label="设置"
          onClick={() => router.push("/settings")}
          className="rounded-md p-2 hover:bg-muted"
        >
          <Settings className="h-4 w-4" />
        </button>
      </header>

      <main className="mx-auto max-w-3xl p-6">
        <h1 className="mb-1 text-xl font-semibold">已装配插件</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          以下插件已在当前服务端真实装配并运行，能力随内核 profiles 自动扩展。
        </p>
        {loading ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : plugins.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无已装配插件</p>
        ) : (
          <ul className="space-y-3">
            {plugins.map((p) => {
              const Icon = ICONS[p.name] ?? Plug;
              return (
                <li
                  key={p.name}
                  className="flex items-start gap-3 rounded-xl border p-4"
                >
                  <span className="rounded-lg bg-muted p-2">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-sm font-medium">{p.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.description}
                    </p>
                    <code className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px]">
                      {p.name}
                    </code>
                  </div>
                  <span className="ml-auto rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                    运行中
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
