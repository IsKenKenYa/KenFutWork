"use client";

import {
  type FlowEngineStackContainer,
  type FlowHostEngineInfoResponse,
} from "@kenfutwork/shared";
import { CircleCheck, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { getServerBaseUrl } from "@/lib/env";
import type { FlowEngineInstallState } from "@/lib/use-flow-engine-install";

/**
 * Flow 模式「引擎」页（宿主侧渲染）：状态 / 承载路径 / 地址 / 容器，一眼看完。
 *
 * 数据面 `GET /api/flow/host/engine/info` 一次取全；安装动作与侧栏共用
 * `useFlowEngineInstall`。呈现纪律：只列宿主真正知道的（不确定的不编）；长文案压一行、
 * 悬停看全文；容器与端口来自 `docker compose ps` 的运行期事实。
 */
export function FlowEnginePage({
  accessToken,
  engineState,
  onInstall,
}: {
  accessToken: string | null;
  engineState: FlowEngineInstallState;
  onInstall: () => Promise<void>;
}) {
  const [info, setInfo] = useState<FlowHostEngineInfoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const response = await fetch(
        `${getServerBaseUrl()}/api/flow/host/engine/info`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!response.ok) {
        throw new Error(
          (await response.json().catch(() => ({})))?.error?.message ??
            `HTTP ${response.status}`,
        );
      }
      setInfo((await response.json()) as FlowHostEngineInfoResponse);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // 安装状态变化（另一入口点了安装、或本轮收尾）→ 重取（容器与状态这时才有新事实）。
  useEffect(() => {
    void refresh();
  }, [engineState, refresh]);

  // 本轮会话状态优先；快照被容器事实校正成 ready 时按钮同步显示「已就绪」。
  const state: FlowEngineInstallState =
    engineState !== "idle"
      ? engineState
      : ((info?.install.state ?? "idle") as FlowEngineInstallState);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-2xl flex-col gap-3 px-6 py-5">
        <header className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">引擎</h1>
          <StatePill state={state} loading={loading && !info} />
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="刷新"
              title="刷新"
              className="flex h-7 w-7 items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void onInstall()}
              disabled={state === "installing" || state === "ready"}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {state === "installing"
                ? "安装中…"
                : state === "ready"
                  ? "已就绪"
                  : state === "error"
                    ? "重试安装"
                    : "安装引擎栈"}
            </button>
          </div>
        </header>

        {loadError ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : null}
        {info?.install.error ? (
          <p className="text-xs text-destructive">{info.install.error}</p>
        ) : null}
        {info && info.install.logTail.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              安装日志
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed">
              {info.install.logTail.join("\n")}
            </pre>
          </details>
        ) : null}

        <Section title="承载路径">
          {info?.probe.paths.map((path) => (
            <Row key={path.id} label={path.label || path.id}>
              <span
                className={
                  path.available ? "text-emerald-600" : "text-muted-foreground"
                }
              >
                {path.available ? "可用" : "不可用"}
              </span>
              {info.probe.recommended === path.id ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                  推荐
                </span>
              ) : null}
              <span
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                title={path.detail ?? path.reason ?? ""}
              >
                {path.detail ?? path.reason ?? ""}
              </span>
            </Row>
          ))}
        </Section>

        <Section title="地址">
          {info ? (
            <>
              <Row label="工作流画布">
                <Address value={info.addresses.frontendUrl} />
              </Row>
              <Row label="身份校验回调">
                <Address value={info.addresses.hostIdentityUrl} />
              </Row>
              <Row label="compose 文件">
                <Address value={info.addresses.composeFile} />
              </Row>
              <Row label="数据目录">
                <Address value={info.addresses.dataDir} />
              </Row>
            </>
          ) : null}
        </Section>

        <Section title="容器">
          {info?.stack.error ? (
            <p className="text-xs text-destructive">{info.stack.error}</p>
          ) : info && info.stack.containers.length > 0 ? (
            info.stack.containers.map((container) => (
              <ContainerRow key={container.name} container={container} />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">没有运行中的容器</p>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5 rounded-xl border px-4 py-3">
      <h2 className="text-xs text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Address({ value }: { value: string | null }) {
  if (!value)
    return <span className="text-xs text-muted-foreground">未配置</span>;
  return (
    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
      {value}
    </span>
  );
}

const STATE_META: Record<
  FlowEngineInstallState,
  { label: string; className: string }
> = {
  idle: { label: "未安装", className: "bg-muted text-muted-foreground" },
  installing: { label: "安装中", className: "bg-muted text-foreground" },
  ready: { label: "已就绪", className: "bg-emerald-500/10 text-emerald-600" },
  error: { label: "安装失败", className: "bg-destructive/10 text-destructive" },
};

function StatePill({
  state,
  loading,
}: {
  state: FlowEngineInstallState;
  loading: boolean;
}) {
  const meta = STATE_META[state];
  return (
    <span
      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${meta.className}`}
    >
      {state === "ready" ? (
        <CircleCheck className="h-3.5 w-3.5" />
      ) : state === "installing" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === "error" ? (
        <TriangleAlert className="h-3.5 w-3.5" />
      ) : null}
      {loading ? "读取中…" : meta.label}
    </span>
  );
}

function ContainerRow({ container }: { container: FlowEngineStackContainer }) {
  const tone =
    container.health === "healthy"
      ? "text-emerald-600"
      : container.health
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className="w-24 shrink-0 truncate font-mono text-xs"
        title={container.name}
      >
        {container.service}
      </span>
      <span className={`text-xs ${tone}`}>
        {container.health ?? container.state}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {container.ports.join("  ")}
      </span>
    </div>
  );
}
