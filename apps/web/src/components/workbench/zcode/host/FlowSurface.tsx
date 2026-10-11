import type {
  FlowEngineLaunch,
  FlowEngineStackContainer,
  FlowHostEngineInfoResponse,
  FlowHostStatusResponse,
} from "@kenfutwork/shared";
import {
  buildFlowHelloAck,
  buildFlowIdentity,
  buildFlowNavigate,
  FLOW_EMBED_PROTOCOL_VERSION,
  parseFlowInbound,
} from "@kenfutwork/shared";
import { CircleCheck, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getFlowSurfaceView,
  registerFlowNavigate,
  setFlowSurfaceView,
  subscribeFlowSurface,
} from "./flowSurfaceState.js";
import { surfaceFetch, surfaceJson } from "./surfaceApi.js";

/** 引擎安装状态（与 shared 的 flowEngineInstallStatusSchema.state 同一枚举）。 */
type FlowEngineInstallState = "idle" | "installing" | "ready" | "error";

type FlowEntry =
  | { available: true; frontendUrl: string }
  | { available: false; reason: string };

/**
 * 换一张一次性身份票据（本地实例身份缝）：宿主凭本机接入（cookie）换票，
 * 随 `ff-embed/identity` 注入 flow；票据由 flow 网关带回宿主验签。
 * 换票失败返回 null——不拿假身份硬握，flow 侧会如实降级并给出原因。
 */
async function fetchIdentityTicket(): Promise<string | null> {
  try {
    const response = await surfaceFetch("/api/flow/host/identity-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === "string" && body.token.length > 0
      ? body.token
      : null;
  } catch {
    return null;
  }
}

/** 引擎栈托管安装（与原「引擎」页同一条状态机：POST → 轮询到 ready/error/超时）。 */
function useFlowEngineInstall(): {
  state: FlowEngineInstallState;
  notice: string | null;
  install: (launch?: FlowEngineLaunch) => Promise<void>;
  stop: (input: { deleteData: boolean }) => Promise<void>;
} {
  const [state, setState] = useState<FlowEngineInstallState>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const install = useCallback(
    async (launch?: FlowEngineLaunch) => {
      if (state === "installing") return;
      setState("installing");
      setNotice(null);
      try {
        const start = await surfaceFetch("/api/flow/host/engine/install", {
          method: "POST",
          ...(launch
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ launch }),
              }
            : {}),
        });
        if (!start.ok && start.status !== 409) {
          const body = (await start.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${start.status}`);
        }
        // 轮询安装状态（拉镜像分钟级；上限 30 分钟防挂死）
        const deadline = Date.now() + 30 * 60 * 1000;
        let snapshot: { state: string; error?: string } = {
          state: "installing",
        };
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const response = await surfaceFetch(
            "/api/flow/host/engine/install/status",
          );
          if (!response.ok) continue;
          snapshot = (await response.json()) as {
            state: string;
            error?: string;
          };
          if (snapshot.state === "ready" || snapshot.state === "error") break;
        }
        if (snapshot.state === "ready") {
          setState("ready");
        } else if (snapshot.state === "error") {
          setNotice(`安装失败：${snapshot.error ?? "详见服务端日志"}`);
          setState("error");
        } else {
          setNotice("安装超时，请稍后重试或查看服务端日志");
          setState("error");
        }
      } catch (error) {
        setNotice(
          `安装失败：${error instanceof Error ? error.message : "未知错误"}`,
        );
        setState("error");
      }
    },
    [state],
  );
  const stop = useCallback(async ({ deleteData }: { deleteData: boolean }) => {
    setNotice(null);
    try {
      const response = await surfaceFetch("/api/flow/host/engine/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteData }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      }
      setState("idle");
    } catch (error) {
      setNotice(
        `停止失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
  }, []);
  return { state, notice, install, stop };
}

/**
 * Flow 主区视图（融合进 Code 壳后的承载面）。
 *
 * 「侧边栏随模式变化」的融合形态：flow 导航（工作流/插件/任务中心/引擎）在
 * **壳侧栏**（HostModeSidebarContent），这里只承载内容面——画布 = 内嵌 flow
 * 前端（iframe）+ `ff-embed/v1` 握手（hello-ack → identity 票据）；引擎 =
 * 紧凑信息页。主区不被对话框顶掉（与 Design 同一条不变量）；子视图与导航
 * 把手共享于 flowSurfaceState.ts（模块级存储）。
 */
export function HostFlowSurface({ active = true }: { active?: boolean }) {
  const view = useSyncExternalStore(subscribeFlowSurface, getFlowSurfaceView);
  const [entry, setEntry] = useState<FlowEntry | null>(null);
  useEffect(() => {
    let cancelled = false;
    surfaceJson<FlowHostStatusResponse>("/api/flow/host/status")
      .then((status) => {
        if (cancelled) return;
        setEntry(
          status.enabled && status.frontendUrl
            ? { available: true, frontendUrl: status.frontendUrl }
            : {
                available: false,
                reason: status.reasons.length
                  ? `宿主适配层未配齐：${status.reasons.join(" ")}`
                  : "宿主适配层未配齐。",
              },
        );
      })
      .catch(() => {
        if (!cancelled)
          setEntry({
            available: false,
            reason: "无法获取 flow 宿主状态（/api/flow/host/status 不可达）。",
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="h-full min-h-0 bg-background">
      {view === "engine" ? (
        <EngineView />
      ) : entry === null ? (
        <div
          role="status"
          className="flex h-full items-center justify-center text-sm text-foreground-subtle"
        >
          正在获取 flow 宿主状态…
        </div>
      ) : entry.available ? (
        <FlowCanvasEmbed frontendUrl={entry.frontendUrl} active={active} />
      ) : (
        <div
          role="status"
          className="flex h-full items-center justify-center px-8 text-center text-sm text-foreground-subtle"
        >
          {entry.reason}
        </div>
      )}
    </div>
  );
}

/** flow 前端 iframe 与 `ff-embed/v1` 握手（hello-ack + 一次性身份票据注入 + 站内导航）。 */
function FlowCanvasEmbed({
  frontendUrl,
  active,
}: {
  frontendUrl: string;
  active: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [connected, setConnected] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  // 引擎没起时 iframe 永远不 onLoad：8 秒后把「正在打开」换成去引擎页的引导，
  // 不让用户对着无限加载发呆（fail loud，不猜「也许马上好」）。
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  useEffect(() => {
    if (frameLoaded) return;
    const timer = window.setTimeout(() => setLoadTimedOut(true), 8000);
    return () => window.clearTimeout(timer);
  }, [frameLoaded]);
  const flowOrigin = useMemo(() => {
    try {
      return new URL(frontendUrl).origin;
    } catch {
      return null;
    }
  }, [frontendUrl]);

  useEffect(() => {
    if (!flowOrigin) return;
    let disposed = false;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== flowOrigin) return;
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const message = parseFlowInbound(event.data, {
        origin: event.origin,
        allowedOrigin: flowOrigin,
      });
      if (!message) return;
      if (message.type === "ff-embed/hello") {
        frame.postMessage(
          buildFlowHelloAck(FLOW_EMBED_PROTOCOL_VERSION),
          flowOrigin,
        );
        void fetchIdentityTicket().then((hostToken) => {
          const target = frameRef.current?.contentWindow;
          if (!disposed && hostToken && target === frame) {
            target.postMessage(
              buildFlowIdentity(FLOW_EMBED_PROTOCOL_VERSION, hostToken),
              flowOrigin,
            );
          }
        });
        return;
      }
      if (message.type === "ff-embed/ready") setConnected(true);
    };
    window.addEventListener("message", onMessage);
    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
    };
  }, [flowOrigin]);

  // 站内导航把手（握手前点击是 no-op，flow 会按默认页落地）；注册进共享状态，
  // 壳侧栏的 flow 导航项经 flowSurfaceState 驱动这里的 iframe 路由。
  useEffect(() => {
    if (!flowOrigin) return;
    registerFlowNavigate((path) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame) return;
      frame.postMessage(
        buildFlowNavigate(FLOW_EMBED_PROTOCOL_VERSION, path),
        flowOrigin,
      );
    });
    return () => {
      registerFlowNavigate(() => {});
    };
  }, [flowOrigin]);

  if (!flowOrigin) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center text-sm text-foreground-subtle"
      >
        flow 前端地址不合法（{frontendUrl}）· 检查 KENFUTWORK_FLOW_FRONTEND_URL
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      <iframe
        ref={frameRef}
        src={frontendUrl}
        title="Flow 工作流画布"
        className={`h-full w-full border-0 transition-opacity duration-300 ${
          frameLoaded ? "opacity-100" : "opacity-0"
        }`}
        inert={!active}
        tabIndex={active ? 0 : -1}
        onLoad={() => setFrameLoaded(true)}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
      {!frameLoaded ? (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-sm text-foreground-subtle"
        >
          {loadTimedOut ? (
            <>
              <p>引擎未就绪</p>
              <button
                type="button"
                onClick={() => setFlowSurfaceView("engine")}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90"
              >
                去引擎页安装
              </button>
            </>
          ) : (
            "正在打开 flow 画布…"
          )}
        </div>
      ) : !connected ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded-full bg-hover/80 px-3 py-1 text-xs text-foreground-subtle"
        >
          正在与 flow 画布握手…
        </div>
      ) : null}
    </div>
  );
}

const ENGINE_STATE_META: Record<
  FlowEngineInstallState,
  { label: string; className: string }
> = {
  idle: { label: "未安装", className: "bg-hover text-foreground-subtle" },
  installing: { label: "安装中", className: "bg-hover text-foreground" },
  ready: { label: "已就绪", className: "bg-emerald-500/10 text-emerald-600" },
  error: { label: "安装失败", className: "bg-destructive/10 text-destructive" },
};

/** 引擎信息页（紧凑版）：状态 / 容器事实 / 地址 / 安装与停止（数据面一次取全）。 */
function EngineView() {
  const [info, setInfo] = useState<FlowHostEngineInfoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stopAsk, setStopAsk] = useState(false);
  const [launchChoice, setLaunchChoice] = useState<FlowEngineLaunch | null>(
    null,
  );
  const { state, notice, install, stop } = useFlowEngineInstall();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(
        await surfaceJson<FlowHostEngineInfoResponse>(
          "/api/flow/host/engine/info",
        ),
      );
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const engineState: FlowEngineInstallState =
    state !== "idle" ? state : (info?.install.state ?? "idle");
  const meta = ENGINE_STATE_META[engineState] ?? ENGINE_STATE_META.idle;
  const wslPath = info?.probe.paths.find((path) => path.id === "wsl2");
  const wslUsable = Boolean(wslPath?.available && wslPath?.distro);
  const activeLaunch: FlowEngineLaunch =
    launchChoice ??
    (info?.probe.recommended === "wsl2" && wslUsable
      ? { kind: "wsl2", distro: wslPath?.distro ?? "" }
      : { kind: "host" });

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex w-full flex-col px-6 py-5">
        <header className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">引擎</h1>
          <span
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${meta.className}`}
          >
            {engineState === "ready" ? (
              <CircleCheck className="h-3.5 w-3.5" />
            ) : engineState === "installing" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : engineState === "error" ? (
              <TriangleAlert className="h-3.5 w-3.5" />
            ) : null}
            {loading && !info ? "读取中…" : meta.label}
          </span>
          <div className="ml-auto flex items-center gap-2">
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
            {engineState === "installing" ? (
              <button
                type="button"
                onClick={() => void stop({ deleteData: false })}
                className="rounded-lg border px-3 py-1.5 text-xs text-foreground-subtle transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                取消安装
              </button>
            ) : engineState === "ready" ? (
              stopAsk ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setStopAsk(false);
                      void stop({ deleteData: false });
                    }}
                    className="rounded-lg border px-3 py-1.5 text-xs transition-colors hover:border-foreground/30"
                  >
                    停止并保留数据
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStopAsk(false);
                      void stop({ deleteData: true });
                    }}
                    className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition-colors hover:border-destructive"
                  >
                    停止并删除数据
                  </button>
                  <button
                    type="button"
                    onClick={() => setStopAsk(false)}
                    className="px-2 py-1.5 text-xs text-foreground-subtle transition-colors hover:text-foreground"
                  >
                    返回
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setStopAsk(true)}
                  className="rounded-lg border px-3 py-1.5 text-xs text-foreground transition-colors hover:border-foreground/30"
                >
                  停止引擎
                </button>
              )
            ) : (
              <>
                {wslUsable ? (
                  <div className="flex items-center gap-1 rounded-full bg-hover/60 p-1">
                    <button
                      type="button"
                      aria-pressed={activeLaunch.kind === "host"}
                      onClick={() => setLaunchChoice({ kind: "host" })}
                      className="rounded-full px-2.5 py-1 text-xs text-foreground-subtle transition-colors aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
                    >
                      本机容器
                    </button>
                    <button
                      type="button"
                      aria-pressed={activeLaunch.kind === "wsl2"}
                      onClick={() =>
                        setLaunchChoice({
                          kind: "wsl2",
                          distro: wslPath?.distro ?? "",
                        })
                      }
                      className="rounded-full px-2.5 py-1 text-xs text-foreground-subtle transition-colors aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
                    >
                      WSL2 · {wslPath?.distro}
                    </button>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => void install(activeLaunch)}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90"
                >
                  {engineState === "error" ? "重试安装" : "安装引擎栈"}
                </button>
              </>
            )}
          </div>
        </header>

        {loadError ? (
          <p className="mt-3 text-xs text-destructive">{loadError}</p>
        ) : null}
        {notice ? (
          <p className="mt-3 text-xs text-destructive">{notice}</p>
        ) : null}
        {info?.install.error ? (
          <p className="mt-3 text-xs text-destructive">{info.install.error}</p>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-xl border text-sm">
          <div className="flex items-center gap-3 border-b px-4 py-2 text-xs text-foreground-subtle">
            <span className="w-28 shrink-0">服务</span>
            <span className="w-20 shrink-0">健康</span>
            <span className="flex-1">端口</span>
          </div>
          {info && info.stack.containers.length > 0 ? (
            info.stack.containers.map(
              (container: FlowEngineStackContainer, index) => (
                <div
                  key={container.name}
                  className={`flex items-center gap-3 px-4 py-2.5 ${
                    index === info.stack.containers.length - 1 ? "" : "border-b"
                  }`}
                >
                  <span
                    className="w-28 shrink-0 truncate font-mono text-xs"
                    title={container.name}
                  >
                    {container.service}
                  </span>
                  <span
                    className={`w-20 shrink-0 text-xs ${
                      container.health === "healthy"
                        ? "text-emerald-600"
                        : container.health
                          ? "text-destructive"
                          : "text-foreground-subtle"
                    }`}
                  >
                    {container.health ?? container.state}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground-subtle"
                    title={container.ports.join("  ")}
                  >
                    {container.ports.join("  ")}
                  </span>
                </div>
              ),
            )
          ) : (
            <p className="px-4 py-3 text-xs text-foreground-subtle">
              {info?.stack.error ?? "没有运行中的容器"}
            </p>
          )}
        </div>

        {info ? (
          <div className="mt-4 overflow-hidden rounded-xl border text-sm">
            <div className="flex items-center gap-3 border-b px-4 py-2 text-xs text-foreground-subtle">
              <span className="w-28 shrink-0">项</span>
              <span className="flex-1">值</span>
            </div>
            {(
              [
                ["工作流画布", info.addresses.frontendUrl],
                ["身份校验回调", info.addresses.hostIdentityUrl],
                ["compose 文件", info.addresses.composeFile],
                ["数据目录", info.addresses.dataDir],
              ] as ReadonlyArray<[string, string | null]>
            ).map(([label, value], index, rows) => (
              <div
                key={label}
                className={`flex items-center gap-3 px-4 py-2.5 ${
                  index === rows.length - 1 ? "" : "border-b"
                }`}
              >
                <span className="w-28 shrink-0 text-foreground-subtle">
                  {label}
                </span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={value ?? ""}
                >
                  {value ?? "未配置"}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
