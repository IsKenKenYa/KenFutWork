"use client";

import {
  type FlowEngineInstallStatus,
  type FlowHostEngineInfoResponse,
  type FlowEngineStackContainer,
} from "@kenfutwork/shared";
import { CircleCheck, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { getServerBaseUrl } from "@/lib/env";
import type { FlowEngineInstallState } from "@/lib/use-flow-engine-install";

/**
 * Flow 模式「引擎」页（宿主侧渲染）：引擎栈的**状态 + 相关信息 + 地址**一处看全。
 *
 * 数据面 `GET /api/flow/host/engine/info` 一次取全（托管状态 / 承载路径探测 / 栈容器事实 /
 * 地址与路径）；安装动作与侧栏快捷按钮共用 `useFlowEngineInstall`（同一份状态，两个入口
 * 行为一致）。呈现纪律：只列宿主真正知道的地址（不确定的不编）；容器与端口来自
 * `docker compose ps` 的运行期事实，查不到就如实说查不到。
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

  // 安装状态变化（另一个入口点了安装、或本轮安装收尾）→ 重新取一次
  // （容器与端口在这时才有新事实；install 状态快照也在刷新）。
  useEffect(() => {
    void refresh();
  }, [engineState, refresh]);

  // 展示口径：本轮会话内的安装状态（engineState）优先于服务端快照——
  // 服务重启后快照归零为 idle，但用户刚点过安装，体感上仍应以本轮为准；
  // 反过来说，快照被容器事实校正成 ready 时，按钮也要跟着显示「已就绪」，
  // 不能出现「上面可以点安装、下面写着已就绪」的自相矛盾。
  const effectiveState: FlowEngineInstallState =
    engineState !== "idle"
      ? engineState
      : ((info?.install.state ?? "idle") as FlowEngineInstallState);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
        <header className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">引擎</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </button>
            <button
              type="button"
              onClick={() => void onInstall()}
              disabled={
                effectiveState === "installing" || effectiveState === "ready"
              }
              className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {effectiveState === "installing"
                ? "安装中…"
                : effectiveState === "ready"
                  ? "已就绪"
                  : effectiveState === "error"
                    ? "重试安装"
                    : "安装引擎栈"}
            </button>
          </div>
        </header>

        {loadError ? (
          <p className="rounded-xl border border-destructive/40 px-4 py-3 text-sm text-destructive">
            {loadError}
          </p>
        ) : null}

        <StatusCard
          state={effectiveState}
          install={info?.install ?? null}
          loading={loading}
        />
        <PathsCard info={info} loading={loading} />
        <AddressesCard info={info} loading={loading} />
        <StackCard info={info} loading={loading} />
      </div>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      <div className="mt-3 flex flex-col gap-2 text-sm">{children}</div>
    </section>
  );
}

const INSTALL_STATE_LABEL: Record<string, string> = {
  idle: "未安装",
  installing: "安装中…",
  ready: "已就绪",
  error: "安装失败",
};

function StatusCard({
  state,
  install,
  loading,
}: {
  state: FlowEngineInstallState;
  install: FlowEngineInstallStatus | null;
  loading: boolean;
}) {
  return (
    <Card title="状态">
      <div className="flex items-center gap-2">
        {state === "ready" ? (
          <CircleCheck className="h-4 w-4 shrink-0 text-emerald-600" />
        ) : state === "installing" ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        ) : state === "error" ? (
          <TriangleAlert className="h-4 w-4 shrink-0 text-destructive" />
        ) : (
          <span className="h-4 w-4 shrink-0 rounded-full border" />
        )}
        <span>{loading && !install ? "读取中…" : INSTALL_STATE_LABEL[state]}</span>
        {install?.startedAt ? (
          <span className="text-xs text-muted-foreground">
            起于 {new Date(install.startedAt).toLocaleString()}
          </span>
        ) : null}
      </div>
      {install?.error ? (
        <p className="text-xs text-destructive">{install.error}</p>
      ) : null}
      {install && install.logTail.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            安装日志（最近 {install.logTail.length} 行）
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed">
            {install.logTail.join("\n")}
          </pre>
        </details>
      ) : null}
    </Card>
  );
}

const PATH_LABEL: Record<string, string> = {
  wsl2: "WSL2",
  container: "本机容器",
  remote: "指向自管地址",
};

function PathsCard({
  info,
  loading,
}: {
  info: FlowHostEngineInfoResponse | null;
  loading: boolean;
}) {
  return (
    <Card title="承载路径">
      {!info ? (
        <p className="text-xs text-muted-foreground">
          {loading ? "读取中…" : "暂无数据"}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {info.probe.paths.map((path) => (
            <li key={path.id} className="flex items-start gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">
                {path.label || PATH_LABEL[path.id] || path.id}
              </span>
              <span className="min-w-0 flex-1">
                <span className={path.available ? "" : "text-muted-foreground"}>
                  {path.available ? "可用" : "不可用"}
                </span>
                {info.probe.recommended === path.id ? (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                    推荐
                  </span>
                ) : null}
                {path.detail ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {path.detail}
                  </span>
                ) : null}
                {!path.available && path.reason ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {path.reason}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AddressesCard({
  info,
  loading,
}: {
  info: FlowHostEngineInfoResponse | null;
  loading: boolean;
}) {
  if (!info) {
    return (
      <Card title="地址">
        <p className="text-xs text-muted-foreground">
          {loading ? "读取中…" : "暂无数据"}
        </p>
      </Card>
    );
  }
  const rows: Array<{ label: string; value: string | null }> = [
    { label: "工作流画布", value: info.addresses.frontendUrl },
    { label: "身份校验回调", value: info.addresses.hostIdentityUrl },
    { label: "compose 文件", value: info.addresses.composeFile },
    { label: "数据目录", value: info.addresses.dataDir },
  ];
  return (
    <Card title="地址">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start gap-2">
          <span className="w-24 shrink-0 text-muted-foreground">
            {row.label}
          </span>
          <span className="min-w-0 flex-1 break-all font-mono text-xs">
            {row.value ?? "未配置"}
          </span>
        </div>
      ))}
    </Card>
  );
}

function StackCard({
  info,
  loading,
}: {
  info: FlowHostEngineInfoResponse | null;
  loading: boolean;
}) {
  return (
    <Card title="引擎栈容器">
      {!info ? (
        <p className="text-xs text-muted-foreground">
          {loading ? "读取中…" : "暂无数据"}
        </p>
      ) : info.stack.error ? (
        <p className="text-xs text-destructive">{info.stack.error}</p>
      ) : info.stack.containers.length === 0 ? (
        <p className="text-xs text-muted-foreground">没有运行中的容器</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {info.stack.containers.map((container) => (
            <ContainerRow key={container.name} container={container} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ContainerRow({ container }: { container: FlowEngineStackContainer }) {
  const healthy = container.health === "healthy";
  const bad = container.health && !healthy;
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="w-32 shrink-0 truncate font-mono text-xs">
          {container.service}
        </span>
        <span
          className={
            healthy ? "text-xs text-emerald-600" : bad ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {container.health ?? container.state}
        </span>
        {container.health && container.health !== container.state ? (
          <span className="text-xs text-muted-foreground">
            {container.state}
          </span>
        ) : null}
      </div>
      {container.ports.length > 0 ? (
        <span className="font-mono text-[11px] text-muted-foreground">
          {container.ports.join("  ")}
        </span>
      ) : null}
    </li>
  );
}
