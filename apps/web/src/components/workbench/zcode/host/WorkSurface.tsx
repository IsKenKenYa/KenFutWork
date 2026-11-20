import {
  ApiAccessError,
  ApiApplicationError,
  type WorkEditor,
  type WorkEditorInstallStatus,
  type WorkFontsResponse,
  type WorkHostEditorsResponse,
  type WorkHostStatusResponse,
  workFontsResponseSchema,
} from "@kenfutwork/shared";
import {
  ZCodeStartupLogoBadge,
  ZCodeStartupSpinner,
} from "@zui/root/RootStartupLoading.js";
import { ArrowLeft, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { fontFamilies } from "./fontFamilies.js";
import { getSurfaceApiBase, surfaceFetch, surfaceJson } from "./surfaceApi.js";
import { useWorkEditorSave } from "./useWorkEditorSave.js";
import {
  chooseWorkDirectory,
  refreshWorkDirectory,
  useWorkDirectory,
} from "./workProjectDirectory.js";
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
  | "cad"
  | "eda";

const CATEGORY_LABEL: Record<WorkEditorCategory, string> = {
  office: "办公",
  image: "图片",
  video: "视频",
  layout: "排版",
  pdf: "PDF",
  audio: "音频",
  cad: "CAD",
  eda: "EDA",
};

const MOUNT_LABEL: Record<WorkEditor["mount"], string> = {
  "wasm-iframe": "内嵌",
  "native-window": "原生窗口",
};

/** 安装进行中轮询间隔；一次性兜底常量（非运行可调治理项），与 flow 安装轮询同口径。 */
const INSTALL_POLL_MS = 2000;
/** 编辑器没发就绪信号时（旧包/非 egui 站点）的兜底显示时间；一次性常量。 */
const EDITOR_READY_FALLBACK_MS = 8000;

/**
 * Work 主区视图（融合进 Code 壳后的承载面）。
 *
 * 信息页 = 注册表 + 落位事实 + 安装动作（仅锚定发布的编辑器有下载按钮）；
 * 编辑器面 = 静态托管的 WASM 站点 iframe。切换只由显式点击驱动
 * （workSurfaceState），主区不被会话或后台事件顶掉。
 */
export function HostWorkSurface({
  active = true,
  onBack,
}: {
  active?: boolean;
  /** 返回会话主区（Work 模式默认主区是共享会话，引擎页是显式打开的视图）。 */
  onBack?: () => void;
}) {
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
    // 目录选择入口已移除，但保存落点仍依赖模块级项目绑定：激活时按服务端
    // 最近更新的 work 项目自动绑定（与 54a23487 的行为一致，不摆入口）。
    void refreshWorkDirectory();
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
    const title =
      editors?.editors.find((editor) => editor.id === view.editorId)?.title ??
      view.editorId;
    return (
      <EditorFrame
        key={view.editorId}
        editorId={view.editorId}
        title={title}
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
      {...(onBack ? { onBack } : {})}
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
  onBack,
  onOpen,
  onInstall,
}: {
  active: boolean;
  status: WorkHostStatusResponse | null;
  editors: WorkHostEditorsResponse | null;
  loading: boolean;
  loadError: string | null;
  onRefresh: () => void;
  onBack?: () => void;
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
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="返回会话"
              title="返回会话"
              className="-ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : null}
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

        <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card text-sm">
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
                  {editor.pinned
                    ? `v${editor.pinned.version}`
                    : editor.version
                      ? `v${editor.version}`
                      : "—"}
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
                      className="shrink-0 rounded-lg border border-border bg-card px-3 py-1 text-xs text-foreground transition-colors hover:border-foreground/30"
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
          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card text-sm">
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

        {editors ? <WorkFontsSection active={active && !loadError} /> : null}
      </div>
    </div>
  );
}

const fontFallback = {
  read: "无法读取字体 请检查本机连接",
  upload: "无法上传字体 请检查本机连接",
  remove: "无法删除字体 请检查本机连接",
};

async function requestFonts(path = "/api/work/host/fonts", init?: RequestInit) {
  return workFontsResponseSchema.parse(await surfaceJson<unknown>(path, init));
}

function useWorkFonts(active: boolean) {
  const [fonts, setFonts] = useState<WorkFontsResponse | null>(null);
  const [notice, setNotice] = useState<{
    action: keyof typeof fontFallback;
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(
    async (
      action: keyof typeof fontFallback,
      operation: () => Promise<void>,
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        await operation();
        setNotice(null);
      } catch (error) {
        const message =
          error instanceof ApiApplicationError
            ? error.status === 401
              ? new ApiAccessError().message
              : error.message
            : fontFallback[action];
        setNotice({ action, message });
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [],
  );
  const load = useCallback(
    () => run("read", async () => setFonts(await requestFonts())),
    [run],
  );
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  function upload(file: File) {
    return run("upload", async () => {
      const body = new FormData();
      body.append("file", file, file.name);
      setFonts(await requestFonts(undefined, { method: "POST", body }));
    });
  }

  function removeAll(fileNames: string[]) {
    return run("remove", async () => {
      for (const fileName of fileNames) {
        setFonts(
          await requestFonts(
            `/api/work/host/fonts/${encodeURIComponent(fileName)}`,
            { method: "DELETE" },
          ),
        );
      }
    });
  }

  return { busy, fonts, notice, load, upload, removeAll };
}

/** 编辑器从该实例读取用户上传的字体。字体不会随应用分发。 */
function WorkFontsSection({ active }: { active: boolean }) {
  const { busy, fonts, notice, load, upload, removeAll } = useWorkFonts(active);
  // 一个家族一份记录：同名的版本注释（预览测试版/轻便版）先归一化再合并，
  // 排序规则见 fontFamilies——英文字体在前、中文在后，各自升序。
  const families = useMemo(() => fontFamilies(fonts?.fonts ?? []), [fonts]);

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card text-sm">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs text-foreground-subtle">
        <span className="flex-1">字体</span>
        <label className="cursor-pointer rounded-md border border-border px-2 py-0.5 text-foreground transition-colors hover:border-foreground/30">
          上传
          <input
            type="file"
            accept=".ttf,.otf,.ttc"
            className="hidden"
            disabled={busy || !fonts}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
      </div>
      {!fonts && !notice ? (
        <p
          role="status"
          className="px-4 py-3 text-center text-xs text-foreground-subtle"
        >
          读取字体中…
        </p>
      ) : null}
      {fonts && families.length === 0 ? (
        <p className="px-4 py-3 text-center text-xs text-foreground-subtle">
          暂无字体
        </p>
      ) : (
        families.map((family, index) => (
          <div
            key={family.name}
            className={`grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 ${
              index === families.length - 1 ? "" : "border-b border-border"
            }`}
          >
            <span className="min-w-0 truncate">{family.name}</span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void removeAll(family.files)}
                className="rounded-md border border-border px-2 py-0.5 text-xs text-foreground-subtle transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
              >
                删除
              </button>
            </span>
          </div>
        ))
      )}
      {fonts?.dir ? (
        <p
          className="truncate border-t border-border px-4 py-2 font-mono text-[11px] text-foreground-subtle"
          title={fonts.dir}
        >
          {fonts.dir}
        </p>
      ) : null}
      {notice ? (
        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-xs">
          <p role="alert" className="flex-1 text-destructive">
            {notice.message}
          </p>
          {notice.action !== "upload" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void load()}
              className="rounded-md border border-border px-2 py-0.5 disabled:opacity-50"
            >
              刷新字体
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function useEditorTheme(): "light" | "dark" {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      return () => observer.disconnect();
    },
    () =>
      document.documentElement.classList.contains("dark") ? "dark" : "light",
    () => "light",
  );
}

/** 编辑器面：静态托管的 WASM 站点（同源鉴权 cookie 随请求带上，无独立握手）。 */
function EditorFrame({
  editorId,
  title,
  onBack,
}: {
  editorId: string;
  title: string;
  onBack: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const editorTheme = useEditorTheme();
  const initialTheme = useRef(editorTheme);
  const { project } = useWorkDirectory();
  // 这两个已锁定的编辑器通过检测系统保存能力来选择其下载备选路径。
  const toProject =
    (editorId === "gridcraft" || editorId === "wordcraft") &&
    Boolean(project?.workDir);
  const initialSaveTarget = useRef(toProject ? "&saveTarget=project" : "");
  const src = `${getSurfaceApiBase()}/api/work/host/editors/${encodeURIComponent(editorId)}/index.html?theme=${initialTheme.current}${initialSaveTarget.current}`;
  const saveFeedback = useWorkEditorSave(frameRef, src, setReady);

  useEffect(() => {
    // about:blank 仍继承宿主 origin，加载前向编辑器 origin 发消息会触发目标源警告。
    // 等编辑器 ready 后发送当前档位；ready 前的切换也由这次 effect 合并为最新值。
    if (!ready) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: "kenfutwork:editor-theme", theme: editorTheme },
      new URL(src).origin,
    );
  }, [editorTheme, ready, src]);

  useEffect(() => {
    if (!ready) return;
    // 目录更新只通知原子页，保留其中尚未保存的编辑内容。
    frameRef.current?.contentWindow?.postMessage(
      { type: "kenfutwork:editor-save-target", toProject },
      new URL(src).origin,
    );
  }, [ready, src, toProject]);

  useEffect(() => {
    if (!frameLoaded) return;
    const timer = window.setTimeout(
      () => setReady(true),
      EDITOR_READY_FALLBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [frameLoaded]);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回编辑器列表"
          title="返回编辑器列表"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="truncate text-sm font-medium">{title}</span>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {saveFeedback?.kind === "error" ? (
            <span role="alert" className="truncate text-xs text-destructive">
              {saveFeedback.text}
            </span>
          ) : saveFeedback ? (
            <span
              role="status"
              className="max-w-[36rem] truncate text-xs text-foreground-subtle"
            >
              {saveFeedback.text}
            </span>
          ) : null}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          ref={frameRef}
          src={src}
          title={title}
          className={`h-full w-full border-0 transition-opacity duration-300 ${
            ready ? "opacity-100" : "opacity-0"
          }`}
          onLoad={() => setFrameLoaded(true)}
        />
        {ready ? null : (
          <div
            role="status"
            aria-busy="true"
            aria-label="正在打开编辑器"
            className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-background"
          >
            <ZCodeStartupLogoBadge />
            <ZCodeStartupSpinner />
          </div>
        )}
      </div>
    </div>
  );
}
