"use client";

import type { PluginExportArtifact } from "@kenfutwork/shared";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { triggerDownload } from "@/lib/download";
import { getServerBaseUrl } from "@/lib/env";
import { serverFetch } from "@/lib/local-access";

/**
 * 导出插件为 bundle：产物**双声明**（`dsh.bundle` + `kenfutwork.bundle`），
 * 同一份文件既能被 dsh 装，也能回灌本项目安装流程。
 */
export function PluginExportDialog({
  name,
  accessToken,
  onClose,
}: {
  name: string | null;
  accessToken: string | null;
  onClose: () => void;
}) {
  const [artifact, setArtifact] = useState<PluginExportArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!name) {
      setArtifact(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    setArtifact(null);
    void serverFetch(`${getServerBaseUrl()}/api/plugins/export`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ name, format: "dsh" }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("导出失败。");
        if (!cancelled) {
          setArtifact((await response.json()) as PluginExportArtifact);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "导出失败。");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name, accessToken]);

  const copy = async (path: string, content: string) => {
    await navigator.clipboard.writeText(content);
    setCopied(path);
    setTimeout(() => setCopied(null), 1500);
  };

  const downloadAll = () => {
    if (!artifact) return;
    const blob = new Blob([JSON.stringify(artifact.files, null, 2)], {
      type: "application/json",
    });
    void triggerDownload(
      `${artifact.name.replace(/[^\w.-]+/g, "-")}-bundle.json`,
      blob,
    );
  };

  return (
    <Dialog open={name !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        aria-describedby={undefined}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3 pr-12">
          <DialogTitle className="text-base font-medium">导出插件</DialogTitle>
          <span className="text-xs text-muted-foreground">{name}</span>
          {artifact ? (
            <button
              type="button"
              onClick={downloadAll}
              className="ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" /> 下载全部
            </button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 text-sm">
          {busy ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 生成中…
            </p>
          ) : error ? (
            <p className="text-destructive">{error}</p>
          ) : artifact ? (
            <>
              <p className="text-xs text-muted-foreground">
                {artifact.installHint}
              </p>
              <div className="mt-3 space-y-3">
                {Object.entries(artifact.files).map(([path, content]) => (
                  <div key={path} className="rounded-lg border">
                    <div className="flex items-center gap-2 border-b px-3 py-1.5">
                      <code className="text-xs font-medium">{path}</code>
                      <button
                        type="button"
                        onClick={() => {
                          void copy(path, content);
                        }}
                        className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-muted"
                      >
                        {copied === path ? (
                          <>
                            <Check className="h-3 w-3" /> 已复制
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" /> 复制
                          </>
                        )}
                      </button>
                    </div>
                    <pre className="max-h-56 overflow-auto px-3 py-2 text-[11px] leading-relaxed">
                      {content}
                    </pre>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
