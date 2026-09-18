"use client";

import type { CompatReport, SandboxPluginBundle } from "@kenfutwork/shared";
import { FolderInput, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { getServerBaseUrl } from "@/lib/env";
import {
  installSandboxPlugin,
  listSandboxPluginBundles,
} from "@/lib/plugins-sandbox";
import { CompatReportView } from "./plugin-compat-report";

/**
 * 从工作目录安装插件：列出当前工作目录里的 bundle 候选（创造模式的插件产物），一键安装。
 *
 * 与「从链接安装」同一条服务端事务：管理员门 + 兼容性门禁都不绕过——不通过时把门禁报告
 * 原样给用户看（而不是只说一句失败）。
 */
export function PluginInstallFromWorkdir({
  accessToken,
  canvasId,
  isAdmin = false,
  onInstalled,
}: {
  accessToken: string | null;
  /** 当前工作目录所在画布（服务端据此解析沙箱目录）。 */
  canvasId: string | null;
  /** 安装要过管理员门：非管理员直接说清，而不是点了才失败。 */
  isAdmin?: boolean;
  onInstalled: () => void;
}) {
  const [bundles, setBundles] = useState<SandboxPluginBundle[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [installingPath, setInstallingPath] = useState<string | null>(null);
  const [report, setReport] = useState<CompatReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(() => {
    setScanning(true);
    setScanError(null);
    void listSandboxPluginBundles({
      baseUrl: getServerBaseUrl(),
      token: accessToken,
      canvasId,
    })
      .then(({ bundles: found, error: reason }) => {
        setBundles(found);
        setScanError(reason);
      })
      .finally(() => setScanning(false));
  }, [accessToken, canvasId]);

  useEffect(() => {
    scan();
  }, [scan]);

  async function install(path: string) {
    setInstallingPath(path);
    setError(null);
    setMessage(null);
    setReport(null);
    const result = await installSandboxPlugin({
      baseUrl: getServerBaseUrl(),
      token: accessToken,
      canvasId,
      path,
    });
    setInstallingPath(null);
    if (!result.ok) {
      setError(result.reason);
      setReport(result.report);
      return;
    }
    setMessage(`已安装「${result.name}@${result.version}」并启用。`);
    onInstalled();
  }

  return (
    <section
      className="rounded-xl border p-4"
      data-testid="install-from-workdir"
    >
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <FolderInput className="h-4 w-4" /> 从工作目录安装
        </h3>
        <button
          type="button"
          onClick={scan}
          disabled={scanning}
          className="rounded-md border px-2 py-1 text-xs disabled:opacity-40"
        >
          {scanning ? "扫描中…" : "刷新"}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        工作目录里的插件会出现在这里，安装前同样会先校验兼容性。
      </p>
      {!isAdmin ? (
        <p className="mt-1 text-xs text-amber-600">
          安装需要管理员权限；你可以照常浏览扫描结果，或复制目录路径交给管理员安装。
        </p>
      ) : null}

      {scanError ? (
        <p className="mt-2 text-xs text-destructive">{scanError}</p>
      ) : null}
      {!scanError && !scanning && bundles.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          当前工作目录里没有插件。
        </p>
      ) : null}

      {bundles.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {bundles.map((item) => (
            <li
              key={item.path}
              className="flex items-center gap-3 rounded-lg border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {item.name}
                  {item.version ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      v{item.version}
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {item.path}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  void install(item.path);
                }}
                disabled={!isAdmin || installingPath !== null}
                className="shrink-0 rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
              >
                {installingPath === item.path ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "安装"
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {report ? (
        <div className="mt-3">
          <CompatReportView report={report} />
        </div>
      ) : null}
      {message ? (
        <p className="mt-2 text-xs text-emerald-600">{message}</p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
