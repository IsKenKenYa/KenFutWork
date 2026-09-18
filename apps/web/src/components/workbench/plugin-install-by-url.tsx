"use client";

import type { CompatReport, PluginBundleManifest } from "@kenfutwork/shared";
import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { getServerBaseUrl } from "@/lib/env";
import { CompatReportView, hasLifecycleIssue } from "./plugin-compat-report";

/**
 * 从链接安装插件：填 GitHub 仓库链接或本地目录 → 先校验兼容性 → 通过才允许安装。
 *
 * 门禁是硬约束：`compatible === false` 时安装按钮不可用，且后端同样会拒绝
 * （前端禁用只是体验，真正的拦截在服务端安装事务里）。
 */
export function PluginInstallByUrl({
  accessToken,
  isAdmin = false,
  onInstalled,
}: {
  accessToken: string | null;
  /** 安装要过管理员门：非管理员直接说清（校验兼容性仍然可用）。 */
  isAdmin?: boolean;
  onInstalled: () => void;
}) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<"inspect" | "install" | null>(null);
  const [report, setReport] = useState<CompatReport | null>(null);
  const [manifest, setManifest] = useState<PluginBundleManifest | null>(null);
  const [allowScripts, setAllowScripts] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const authHeaders = (): Record<string, string> =>
    accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

  const reset = () => {
    setReport(null);
    setManifest(null);
    setAllowScripts(false);
    setMessage(null);
    setError(null);
  };

  async function inspect() {
    if (!source.trim()) return;
    setBusy("inspect");
    reset();
    try {
      const response = await fetch(
        `${getServerBaseUrl()}/api/plugins/inspect`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ url: source.trim() }),
        },
      );
      const payload = (await response.json()) as {
        manifest?: PluginBundleManifest;
        report?: CompatReport;
        error?: { message?: string };
      };
      if (!response.ok || !payload.report) {
        setError(payload.error?.message ?? "无法获取插件来源。");
        return;
      }
      setReport(payload.report);
      setManifest(payload.manifest ?? null);
    } catch {
      setError("校验请求失败。");
    } finally {
      setBusy(null);
    }
  }

  async function install() {
    if (!source.trim() || !report?.compatible) return;
    setBusy("install");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `${getServerBaseUrl()}/api/plugins/install`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            url: source.trim(),
            allowLifecycleScripts: allowScripts,
          }),
        },
      );
      const payload = (await response.json()) as {
        report?: CompatReport;
        error?: { message?: string };
      };
      if (!response.ok) {
        if (payload.report) setReport(payload.report);
        setError(payload.error?.message ?? "安装失败。");
        return;
      }
      setMessage("安装完成。");
      onInstalled();
    } catch {
      setError("安装请求失败。");
    } finally {
      setBusy(null);
    }
  }

  const blocked = report !== null && !report.compatible;

  return (
    <section className="rounded-xl border p-4" data-testid="install-by-url">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4" /> 从链接安装
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        填 GitHub 仓库链接或本机目录路径，安装前会先校验兼容性。
      </p>

      {!isAdmin ? (
        <p className="mt-1 text-xs text-amber-600">
          安装需要管理员权限；「校验兼容性」不受影响。
        </p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <input
          aria-label="插件来源"
          placeholder="https://github.com/owner/repo 或 D:\\path\\to\\plugin"
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            reset();
          }}
          className="min-w-0 flex-1 rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none"
        />
        <button
          type="button"
          onClick={() => {
            void inspect();
          }}
          disabled={busy !== null || !source.trim()}
          className="shrink-0 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {busy === "inspect" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            "校验兼容性"
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            void install();
          }}
          disabled={!isAdmin || busy !== null || !report?.compatible}
          data-testid="install-button"
          className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
        >
          {busy === "install" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            "安装"
          )}
        </button>
      </div>

      {manifest ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {manifest.name}@{manifest.version}
          {manifest.requiredCapabilities.length > 0
            ? ` · 需要能力：${manifest.requiredCapabilities.join("、")}`
            : ""}
        </p>
      ) : null}

      {report ? (
        <div className="mt-3 space-y-2">
          <CompatReportView report={report} />
          {hasLifecycleIssue(report) ? (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={allowScripts}
                onChange={(event) => setAllowScripts(event.target.checked)}
                className="mt-0.5"
                data-testid="allow-lifecycle"
              />
              <span>
                我了解该插件会在<b>安装时执行任意代码</b>，并授权执行。
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      {blocked ? (
        <p
          className="mt-2 text-xs text-destructive"
          data-testid="install-blocked"
        >
          兼容性校验未通过，安装已被阻止。
        </p>
      ) : null}
      {message ? (
        <p className="mt-2 text-xs text-emerald-600">{message}</p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
