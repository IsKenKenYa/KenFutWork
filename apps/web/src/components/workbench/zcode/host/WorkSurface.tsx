import type {
  WorkEditor,
  WorkEditorInstallStatus,
  WorkHostEditorsResponse,
  WorkHostStatusResponse,
} from "@kenfutwork/shared";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSyncExternalStore } from "react";
import { surfaceFetch, surfaceJson } from "./surfaceApi.js";
import { getSurfaceApiBase } from "./surfaceApi.js";
import {
  getWorkSurfaceView,
  openWorkEditor,
  openWorkEditors,
  subscribeWorkSurface,
} from "./workSurfaceState.js";

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

/** 安装进行中轮询间隔；一次性兜底常量（非运行可调治理项），与 flow 安装轮询同口径。 */
const INSTALL_POLL_MS = 2000;

/**
 * Work 主区视图（融合进 Code 壳后的承载面）。
 *
 * 信息页 = 注册表 + 落位事实 + 安装动作（仅锚定发布的编辑器有下载按钮）；
 * 编辑器面 = 静态托管的 WASM 站点 iframe。切换只由显式点击驱动
 * （workSurfaceState），主区不被会话或后台事件顶掉。
 */
export function HostWorkSurface({ active = true }: { active?: boolean }) {
  const view = useSyncExternalStore(
    subscribeWorkSurface,
    getWorkSurfaceView,
    getWorkSurfaceView,
  );
  const [status, setStatus] = useState<WorkHostStatusResponse | null>(null);
  const [editors, setEditors] = useState<WorkHostEditorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
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

  const installing = Object.values(editors?.install ?? {}).some(
    (snap) => snap.state === "installing",
  );
  useEffect(() => {
    if (!active || !installing) return;
    const timer = window.setInterval(() => void refresh(), INSTALL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, installing, refresh]);

  if (view.kind === "editor") {
    return (
      <EditorFrame
        editorId={view.editorId}
        onBack={openWorkEditors}
      />
    );
  }
  return (
    <EditorsInfoView
      active={active}
      status={status}
      editors={editors}
      loading={loading}
      loadError={loadError}
      onRefresh={() => void refresh()}
      onOpen={openWorkEditor}
      onInstall={async (editorId) => {
        try {
          await surfaceFetch(
            `/api/work/host/editors/${encodeURIComponent(editorId)}/install`,
            { method: "POST" },
          );
        } catch {
          // 启动失败会被下一次轮询的快照如实呈现，不在这里弹错。
        }
        void refresh();
      }}
    />
  );
}

function EditorsInfoView({
  active,
  status,
  editors,
  loading,
  loadError,
  onRefresh,
  onOpen,
  onInstall,
}: {
  active: boolean;
  status: WorkHostStatusResponse | null;
  editors: WorkHostEditorsResponse | null;
  loading: boolean;
  loadError: string | null;
  onRefresh: () => void;
  onOpen: (editorId: string) => void;
  onInstall: (editorId: string) => Promise<void>;
}) {
  const installFor = (editor: WorkEditor): WorkEditorInstallStatus =>
    editors?.install[editor.id] ?? { state: "idle", logTail: [] };
  const installing = Object.values(editors?.install ?? {}).some(
    (snap) => snap.state === "installing",
  );
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
              onClick={onRefresh}
              disabled={loading || installing}
              aria-label="刷新"
              title="刷新"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-border text-foreground-subtle transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
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

        <div className="mt-4 overflow-hidden rounded-xl border border-border text-sm">
          {/* 列宽均分（grid-cols-5）+ 单元格居中：定宽 flex 会让「状态」列吃掉剩余宽度，
              右侧留一大片空白，看着不像表格。 */}
          <div className="grid grid-cols-5 items-center gap-3 border-b border-border px-4 py-2 text-xs text-foreground-subtle">
            <span className="text-center">编辑器</span>
            <span className="text-center">类别</span>
            <span className="text-center">挂载</span>
            <span className="text-center">版本</span>
            <span className="text-center">状态</span>
          </div>
          {(editors?.editors ?? []).map((editor, index, rows) => {
            const install = installFor(editor);
            return (
              <div
                key={editor.id}
                className={`grid grid-cols-5 items-center gap-3 px-4 py-2.5 text-center ${
                  index === rows.length - 1 ? "" : "border-b border-border"
                }`}
              >
                <span className="min-w-0 truncate" title={editor.id}>
                  {editor.title}
                </span>
                <span className="text-xs text-foreground-subtle">
                  {CATEGORY_LABEL[editor.category] ?? editor.category}
                </span>
                <span className="text-xs text-foreground-subtle">
                  {MOUNT_LABEL[editor.mount] ?? editor.mount}
                </span>
                <span className="font-mono text-[11px] text-foreground-subtle">
                  {editor.pinned ? `v${editor.pinned.version}` : "—"}
                </span>
                <span className="flex min-w-0 items-center justify-center gap-2 text-xs">
                  {install.state === "installing" ? (
                    <>
                      <span className="text-foreground">
                        {install.logTail.at(-1) ?? "安装中"}
                      </span>
                    </>
                  ) : install.state === "error" ? (
                    <>
                      <span className="text-destructive">{install.error}</span>
                      {editor.pinned ? (
                        <button
                          type="button"
                          onClick={() => void onInstall(editor.id)}
                          className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs transition-colors hover:border-foreground/30"
                        >
                          重试
                        </button>
                      ) : null}
                    </>
                  ) : editor.installed ? (
                    <button
                      type="button"
                      onClick={() => onOpen(editor.id)}
                      className="shrink-0 rounded-lg border border-border bg-hover px-3 py-1 text-xs text-foreground transition-colors hover:border-foreground/30"
                    >
                      打开
                    </button>
                  ) : editor.pinned ? (
                    <button
                      type="button"
                      onClick={() => void onInstall(editor.id)}
                      className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs transition-colors hover:border-foreground/30"
                    >
                      下载
                    </button>
                  ) : (
                    <span className="text-foreground-subtle">未锚定</span>
                  )}
                </span>
              </div>
            );
          })}
          {editors && editors.editors.length === 0 ? (
            <p className="px-4 py-3 text-xs text-foreground-subtle">
              没有已登记的编辑器
            </p>
          ) : null}
        </div>

        {editors ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-border text-sm">
            <div className="grid grid-cols-2 items-center gap-3 border-b border-border px-4 py-2 text-xs text-foreground-subtle">
              <span className="text-center">项</span>
              <span className="text-center">值</span>
            </div>
            <div className="grid grid-cols-2 items-center gap-3 px-4 py-2.5">
              <span className="text-center text-foreground-subtle">
                数据目录
              </span>
              <span
                className="min-w-0 truncate text-center font-mono text-xs"
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

/** 编辑器面：静态托管的 WASM 站点（同源鉴权 cookie 随请求带上，无独立握手）。 */
function EditorFrame({
  editorId,
  onBack,
}: {
  editorId: string;
  onBack: () => void;
}) {
  const [frameLoaded, setFrameLoaded] = useState(false);
  const src = `${getSurfaceApiBase()}/api/work/host/editors/${encodeURIComponent(editorId)}/index.html`;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs text-foreground-subtle transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          编辑器
        </button>
        <span className="text-sm">{editorId}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          src={src}
          title={`${editorId} 编辑器`}
          className={`h-full w-full border-0 transition-opacity duration-300 ${
            frameLoaded ? "opacity-100" : "opacity-0"
          }`}
          onLoad={() => setFrameLoaded(true)}
        />
        {!frameLoaded ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-foreground-subtle">
            正在打开编辑器…
          </div>
        ) : null}
      </div>
    </div>
  );
}
