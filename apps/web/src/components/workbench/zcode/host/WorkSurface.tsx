import type {
  WorkEditor,
  WorkHostEditorsResponse,
  WorkHostStatusResponse,
} from "@kenfutwork/shared";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

/** 编辑器类别（与 shared workEditorCategorySchema 同一封闭集）。 */
type WorkEditorCategory =
  | "office"
  | "image"
  | "video"
  | "layout"
  | "pdf"
  | "audio"
  | "cad";

const CATEGORY_LABEL: Record<WorkEditorCategory, string> = {
  office: "办公",
  image: "图片",
  video: "视频",
  layout: "排版",
  pdf: "PDF",
  audio: "音频",
  cad: "CAD",
};

const MOUNT_LABEL: Record<WorkEditor["mount"], string> = {
  "wasm-iframe": "内嵌",
  "native-window": "原生窗口",
};

/**
 * Work 主区视图（融合进 Code 壳后的承载面，W1：只读引擎信息页）。
 *
 * 入口纪律：能进入本面 = work 插件已安装且探针可用（父页门控），所以这里
 * 不再判断安装态，只如实呈现注册表与落位事实。编辑器二进制按需下载（W2
 * 接通后此处出现安装动作），未落位如实标「未下载」，不摆假按钮。
 */
export function HostWorkSurface({ active = true }: { active?: boolean }) {
  const [status, setStatus] = useState<WorkHostStatusResponse | null>(null);
  const [editors, setEditors] = useState<WorkHostEditorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextEditors] = await Promise.all([
        surfaceJson<WorkHostStatusResponse>("/api/work/host/status"),
        surfaceJson<WorkHostEditorsResponse>("/api/work/host/editors"),
      ]);
      setStatus(nextStatus);
      setEditors(nextEditors);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background">
      <div className="flex w-full flex-col px-6 py-5">
        <header className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Work 引擎</h1>
          <span className="rounded-full bg-hover px-2 py-0.5 text-xs text-foreground-subtle">
            {loading && !status
              ? "读取中…"
              : status?.enabled
                ? `${status.registeredEditors} 项已登记`
                : "未启用"}
          </span>
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="刷新"
              title="刷新"
              className="flex h-7 w-7 items-center justify-center rounded-lg border text-foreground-subtle transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {loadError ? (
          <p className="mt-3 text-xs text-destructive">{loadError}</p>
        ) : null}
        {status && !status.enabled && status.reasons.length > 0 ? (
          <p className="mt-3 text-xs text-destructive">
            {status.reasons.join(" ")}
          </p>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-xl border text-sm">
          <div className="flex items-center gap-3 border-b px-4 py-2 text-xs text-foreground-subtle">
            <span className="w-24 shrink-0">编辑器</span>
            <span className="w-14 shrink-0">类别</span>
            <span className="w-16 shrink-0">挂载</span>
            <span className="w-36 shrink-0">许可证</span>
            <span className="flex-1">状态</span>
          </div>
          {(editors?.editors ?? []).map((editor, index, rows) => (
            <div
              key={editor.id}
              className={`flex items-center gap-3 px-4 py-2.5 ${
                index === rows.length - 1 ? "" : "border-b"
              }`}
            >
              <span className="w-24 shrink-0 truncate" title={editor.id}>
                {editor.title}
              </span>
              <span className="w-14 shrink-0 text-xs text-foreground-subtle">
                {CATEGORY_LABEL[editor.category] ?? editor.category}
              </span>
              <span className="w-16 shrink-0 text-xs text-foreground-subtle">
                {MOUNT_LABEL[editor.mount] ?? editor.mount}
              </span>
              <span
                className="w-36 shrink-0 truncate font-mono text-[11px] text-foreground-subtle"
                title={editor.license}
              >
                {editor.license}
              </span>
              <span className="min-w-0 flex-1 text-xs">
                {editor.installed ? (
                  <span className="text-emerald-600">已就绪</span>
                ) : (
                  <span className="text-foreground-subtle">未下载</span>
                )}
              </span>
            </div>
          ))}
          {editors && editors.editors.length === 0 ? (
            <p className="px-4 py-3 text-xs text-foreground-subtle">
              没有已登记的编辑器
            </p>
          ) : null}
        </div>

        {editors ? (
          <div className="mt-4 overflow-hidden rounded-xl border text-sm">
            <div className="flex items-center gap-3 border-b px-4 py-2 text-xs text-foreground-subtle">
              <span className="w-28 shrink-0">项</span>
              <span className="flex-1">值</span>
            </div>
            <div className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-28 shrink-0 text-foreground-subtle">
                数据目录
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs"
                title={editors.dataDir}
              >
                {editors.dataDir}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
