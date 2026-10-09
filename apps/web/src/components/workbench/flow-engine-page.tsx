"use client";

import type {
  FlowEngineStackContainer,
  FlowHostEngineInfoResponse,
} from "@kenfutwork/shared";
import { CircleCheck, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { getServerBaseUrl } from "@/lib/env";
import type { FlowEngineInstallState } from "@/lib/use-flow-engine-install";

/**
 * Flow 模式「引擎」页（宿主侧渲染）：资源管理器式排版——标题行 + 分段页签 +
 * 概览卡 + 表格，一屏一块表，不堆卡片。
 *
 * 数据面 `GET /api/flow/host/engine/info` 一次取全（本机接入 cookie，credentials: include）；
 * 安装动作与侧栏共用 `useFlowEngineInstall`。呈现纪律：只列宿主真正知道的（不确定的不编）；长值单行
 * 省略、悬停看全文；容器与端口来自 `docker compose ps` 的运行期事实。
 */

type TabId = "containers" | "paths" | "addresses";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "containers", label: "容器" },
  { id: "paths", label: "承载路径" },
  { id: "addresses", label: "地址" },
];

export function FlowEnginePage({
  engineState,
  engineNotice,
  onInstall,
  onStop,
}: {
  engineState: FlowEngineInstallState;
  /** 安装失败 / 超时的可读原因（hook 返回；成功为 null）。 */
  engineNotice: string | null;
  onInstall: () => Promise<void>;
  /** 停止／取消引擎栈：`deleteData` 显式选择才全删容器卷（§9.1③）。 */
  onStop: (input: { deleteData: boolean }) => Promise<void>;
}) {
  const [info, setInfo] = useState<FlowHostEngineInfoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("containers");
  // 「停止引擎」先亮出「保留数据 / 删除数据」两个选项再动手——不静默删数据。
  const [stopAsk, setStopAsk] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `${getServerBaseUrl()}/api/flow/host/engine/info`,
        { credentials: "include" },
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
  }, []);

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

  const recommendation = info?.probe.paths.find(
    (path) => path.id === info.probe.recommended,
  );

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="flex w-full flex-col px-8 pt-8 pb-8">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">引擎</h1>
              <StatePill state={state} loading={loading && !info} />
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {info
                ? `${info.stack.containers.length} 个容器${
                    recommendation ? ` · ${recommendation.label}` : ""
                  }`
                : loading
                  ? "读取中…"
                  : "暂无数据"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
            {state === "installing" ? (
              <button
                type="button"
                onClick={() => void onStop({ deleteData: false })}
                className="rounded-lg border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                取消安装
              </button>
            ) : state === "ready" ? (
              stopAsk ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setStopAsk(false);
                      void onStop({ deleteData: false });
                    }}
                    className="rounded-lg border px-3 py-1.5 text-xs transition-colors hover:border-foreground/30"
                  >
                    停止并保留数据
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStopAsk(false);
                      void onStop({ deleteData: true });
                    }}
                    className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition-colors hover:border-destructive"
                  >
                    停止并删除数据
                  </button>
                  <button
                    type="button"
                    onClick={() => setStopAsk(false)}
                    className="px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
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
              <button
                type="button"
                onClick={() => void onInstall()}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {state === "error" ? "重试安装" : "安装引擎栈"}
              </button>
            )}
          </div>
        </header>

        {loadError ? (
          <p className="mt-3 text-xs text-destructive">{loadError}</p>
        ) : null}
        {engineNotice ? (
          <p className="mt-3 text-xs text-destructive">{engineNotice}</p>
        ) : null}
        {info?.install.error ? (
          <p className="mt-3 text-xs text-destructive">{info.install.error}</p>
        ) : null}
        {info && info.install.logTail.length > 0 ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              安装日志
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed">
              {info.install.logTail.join("\n")}
            </pre>
          </details>
        ) : null}

        <nav className="mt-4 flex w-fit items-center gap-1 rounded-full bg-muted/60 p-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              data-active={tab === item.id}
              className="rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-sm"
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="mt-3 rounded-xl border">
          {tab === "containers" ? <ContainersTab info={info} /> : null}
          {tab === "paths" ? <PathsTab info={info} /> : null}
          {tab === "addresses" ? <AddressesTab info={info} /> : null}
        </div>
      </div>
    </div>
  );
}

function TableHead({ columns }: { readonly columns: readonly string[] }) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
      {columns.map((column, index) => (
        <span
          key={column}
          className={
            index === 0
              ? "w-28 shrink-0"
              : index === 1
                ? "w-20 shrink-0"
                : "flex-1"
          }
        >
          {column}
        </span>
      ))}
    </div>
  );
}

function TableRow({
  children,
  last,
}: {
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 text-sm ${
        last ? "" : "border-b"
      }`}
    >
      {children}
    </div>
  );
}

function ContainersTab({ info }: { info: FlowHostEngineInfoResponse | null }) {
  if (!info) return <Empty />;
  if (info.stack.error) {
    return (
      <p className="px-4 py-3 text-xs text-destructive">{info.stack.error}</p>
    );
  }
  const containers = info.stack.containers;
  if (containers.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        没有运行中的容器
      </p>
    );
  }
  const running = containers.filter((item) => item.state === "running").length;
  const healthy = containers.filter((item) => item.health === "healthy").length;
  return (
    <>
      <Summary
        label="容器"
        value={`${running} / ${containers.length}`}
        suffix="运行中"
        ratio={containers.length ? running / containers.length : 0}
        legend={[
          { text: `健康 ${healthy}` },
          { text: `无探针 ${containers.length - healthy}` },
        ]}
      />
      <TableHead columns={["服务", "健康", "端口"]} />
      {containers.map((container, index) => (
        <ContainerRow
          key={container.name}
          container={container}
          last={index === containers.length - 1}
        />
      ))}
    </>
  );
}

function Summary({
  label,
  value,
  suffix,
  ratio,
  legend,
}: {
  label: string;
  value: string;
  suffix: string;
  ratio: number;
  legend: ReadonlyArray<{ text: string }>;
}) {
  return (
    <div className="flex flex-col gap-3 border-b px-4 py-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <p className="text-2xl font-semibold tracking-tight">
        {value}{" "}
        <span className="text-sm font-normal text-muted-foreground">
          {suffix}
        </span>
      </p>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary/80"
          style={{
            width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`,
          }}
        />
      </div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        {legend.map((item) => (
          <span key={item.text} className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-foreground/40" />
            {item.text}
          </span>
        ))}
      </div>
    </div>
  );
}

function ContainerRow({
  container,
  last,
}: {
  container: FlowEngineStackContainer;
  last: boolean;
}) {
  const tone =
    container.health === "healthy"
      ? "text-emerald-600"
      : container.health
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <TableRow last={last}>
      <span
        className="w-28 shrink-0 truncate font-mono text-xs"
        title={container.name}
      >
        {container.service}
      </span>
      <span className={`w-20 shrink-0 text-xs ${tone}`}>
        {container.health ?? container.state}
      </span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
        title={container.ports.join("  ")}
      >
        {container.ports.join("  ")}
      </span>
    </TableRow>
  );
}

function PathsTab({ info }: { info: FlowHostEngineInfoResponse | null }) {
  if (!info) return <Empty />;
  const paths = info.probe.paths;
  return (
    <>
      <TableHead columns={["路径", "可用性", "说明"]} />
      {paths.map((path, index) => (
        <TableRow key={path.id} last={index === paths.length - 1}>
          <span className="flex w-28 shrink-0 items-center gap-1.5">
            {path.label || path.id}
            {info.probe.recommended === path.id ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                推荐
              </span>
            ) : null}
          </span>
          <span
            className={`w-20 shrink-0 text-xs ${
              path.available ? "text-emerald-600" : "text-muted-foreground"
            }`}
          >
            {path.available ? "可用" : "不可用"}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={path.detail ?? path.reason ?? ""}
          >
            {path.detail ?? path.reason ?? ""}
          </span>
        </TableRow>
      ))}
    </>
  );
}

function AddressesTab({ info }: { info: FlowHostEngineInfoResponse | null }) {
  if (!info) return <Empty />;
  const rows: ReadonlyArray<{ label: string; value: string | null }> = [
    { label: "工作流画布", value: info.addresses.frontendUrl },
    { label: "身份校验回调", value: info.addresses.hostIdentityUrl },
    { label: "compose 文件", value: info.addresses.composeFile },
    { label: "数据目录", value: info.addresses.dataDir },
  ];
  return (
    <>
      <TableHead columns={["项", "", "值"]} />
      {rows.map((row, index) => (
        <TableRow key={row.label} last={index === rows.length - 1}>
          <span className="w-28 shrink-0 text-muted-foreground">
            {row.label}
          </span>
          <span className="w-20 shrink-0" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs"
            title={row.value ?? ""}
          >
            {row.value ?? "未配置"}
          </span>
        </TableRow>
      ))}
    </>
  );
}

function Empty() {
  return <p className="px-4 py-3 text-xs text-muted-foreground">读取中…</p>;
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
