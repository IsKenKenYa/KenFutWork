"use client";

import type {
  McpCuratedServer,
  McpRegistryServer,
  McpServerView,
} from "@kenfutwork/shared";
import { Loader2, Plus, RefreshCw, Search, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getServerBaseUrl } from "@/lib/env";
import { buildCuratedServerPayload } from "@/lib/mcp-catalog";
import {
  buildMcpServerPayload,
  formatArgsText,
  type McpServerFormInput,
} from "@/lib/mcp-form";
import { ListEmpty, ListError, ListLoading } from "./list-state";

const EMPTY_FORM: McpServerFormInput = {
  name: "",
  kind: "stdio",
  command: "",
  url: "",
  argsText: "",
  envText: "",
};

type McpTab = "configured" | "curated" | "registry";

/** 直接创建配置的载荷（stdio/http 两类，推荐与市场页签共用）。 */
type McpCreatePayload = {
  name: string;
  kind: "stdio" | "http";
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
};

/**
 * MCP 管理弹窗（从「设置」挪到侧栏，与技能并列）。
 *
 * 三个页签：**已配置**（列表/启停/重连/编辑/删除 + 手动添加）、
 * **推荐**（内置精选目录，一键添加，参数就地填）、
 * **官方 MCP 市场**（registry.modelcontextprotocol.io 检索；stdio 包与远程端点都可添加）。
 *
 * 安全：MCP server 会在本机以子进程执行命令——变更类操作服务端有管理员门，
 * 界面也逐条提示，不做静默安装。
 */
export function McpModal({
  open,
  onClose,
  accessToken,
}: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
}) {
  const [tab, setTab] = useState<McpTab>("configured");
  /** 切页签重置滚动位置（残留滚动是明显的交互脏感）。 */
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const authHeaders = useCallback(
    (): Record<string, string> =>
      accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    [accessToken],
  );

  const refresh = useCallback(() => {
    setLoading(true);
    void fetch(`${getServerBaseUrl()}/api/mcp/servers`, {
      headers: authHeaders(),
    })
      .then((response) => (response.ok ? response.json() : { servers: [] }))
      .then((data: { servers: McpServerView[] }) => setServers(data.servers))
      .catch(() => setError("MCP 列表加载失败。"))
      .finally(() => setLoading(false));
  }, [authHeaders]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const readError = useCallback(
    async (response: Response, fallback: string) => {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      return payload.error?.message ?? fallback;
    },
    [],
  );

  /** 直接创建配置（推荐/注册表两个页签共用）。 */
  const createServer = useCallback(
    async (payload: McpCreatePayload) => {
      setBusy(payload.name);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch(`${getServerBaseUrl()}/api/mcp/servers`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ ...payload, enabled: true }),
        });
        if (!response.ok) {
          setError(await readError(response, "添加失败（需要管理员权限）。"));
          return false;
        }
        setNotice(`已添加「${payload.name}」· 在「已配置」查看连接状态`);
        setTab("configured");
        refresh();
        return true;
      } catch {
        setError("添加请求失败。");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [authHeaders, refresh, readError],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex h-[80vh] max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        aria-describedby={undefined}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3 pr-12">
          <DialogTitle className="flex shrink-0 items-center gap-2 text-base font-medium">
            <Server className="h-4 w-4" /> MCP
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-1 rounded-lg bg-muted p-1">
            {(
              [
                { id: "configured", label: "已配置" },
                { id: "curated", label: "推荐" },
                { id: "registry", label: "官方 MCP 市场" },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                data-active={tab === item.id}
                onClick={() => {
                  setTab(item.id);
                  if (contentRef.current) contentRef.current.scrollTop = 0;
                }}
                className="whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:shadow-sm"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div
          ref={contentRef}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5"
        >
          {notice ? <p className="text-xs text-emerald-600">{notice}</p> : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          {tab === "configured" ? (
            <ConfiguredTab
              servers={servers}
              loading={loading}
              busy={busy}
              authHeaders={authHeaders}
              readError={readError}
              onChanged={refresh}
              setBusy={setBusy}
              setError={setError}
              setNotice={setNotice}
            />
          ) : tab === "curated" ? (
            <CuratedTab
              busy={busy}
              authHeaders={authHeaders}
              onCreate={createServer}
            />
          ) : (
            <RegistryTab
              busy={busy}
              authHeaders={authHeaders}
              onCreate={createServer}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────── 已配置 ────────────────────────── */

function ConfiguredTab({
  servers,
  loading,
  busy,
  authHeaders,
  readError,
  onChanged,
  setBusy,
  setError,
  setNotice,
}: {
  servers: McpServerView[];
  loading: boolean;
  busy: string | null;
  authHeaders: () => Record<string, string>;
  readError: (response: Response, fallback: string) => Promise<string>;
  onChanged: () => void;
  setBusy: (value: string | null) => void;
  setError: (value: string | null) => void;
  setNotice: (value: string | null) => void;
}) {
  const [form, setForm] = useState<McpServerFormInput>(EMPTY_FORM);
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [envTouched, setEnvTouched] = useState(false);

  async function act(
    server: McpServerView,
    action: "toggle" | "delete" | "reconnect",
  ) {
    const key = server.id ?? server.name;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const base = getServerBaseUrl();
      const response =
        action === "delete"
          ? await fetch(`${base}/api/mcp/servers/${server.id}`, {
              method: "DELETE",
              headers: authHeaders(),
            })
          : action === "toggle"
            ? await fetch(`${base}/api/mcp/servers/${server.id}`, {
                method: "PATCH",
                headers: {
                  "content-type": "application/json",
                  ...authHeaders(),
                },
                body: JSON.stringify({ enabled: !server.enabled }),
              })
            : await fetch(
                `${base}/api/mcp/servers/${encodeURIComponent(
                  server.id ?? server.name,
                )}/reconnect`,
                { method: "POST", headers: authHeaders() },
              );
      if (!response.ok) {
        setError(await readError(response, "操作失败（需要管理员权限）。"));
        return;
      }
      setNotice(
        action === "delete"
          ? `已删除「${server.name}」。`
          : action === "toggle"
            ? `${server.enabled ? "已停用" : "已启用"}「${server.name}」。`
            : `已重连「${server.name}」。`,
      );
      onChanged();
    } catch {
      setError("操作请求失败。");
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    const { errors, payload } = buildMcpServerPayload(form, {
      mode: editing ? "edit" : "create",
      envTouched: editing ? envTouched : true,
    });
    if (errors.length > 0) {
      setError(errors.join(" "));
      return;
    }
    setBusy(editing ? editing.id : "create");
    setError(null);
    setNotice(null);
    try {
      const base = getServerBaseUrl();
      const response = editing
        ? await fetch(`${base}/api/mcp/servers/${editing.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", ...authHeaders() },
            body: JSON.stringify(payload),
          })
        : await fetch(`${base}/api/mcp/servers`, {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders() },
            body: JSON.stringify(payload),
          });
      if (!response.ok) {
        setError(
          await readError(response, "保存失败（变更类操作需要管理员）。"),
        );
        return;
      }
      setNotice(editing ? "已保存并重连。" : `已添加「${payload.name}」。`);
      setForm(EMPTY_FORM);
      setEditing(null);
      setEnvTouched(false);
      onChanged();
    } catch {
      setError("保存请求失败。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        添加、修改与删除需要管理员权限
      </p>

      {loading ? (
        <ListLoading label="正在加载已配置的 MCP 服务…" rows={2} />
      ) : servers.length === 0 ? (
        <ListEmpty title="尚未配置 MCP 服务" hint="在「推荐」里一键添加" />
      ) : (
        <ul className="space-y-2">
          {servers.map((server) => {
            const key = server.id ?? server.name;
            return (
              <li key={key} className="rounded-xl border p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Server className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm font-medium">{server.name}</span>
                      <Tag>
                        {server.source === "env" ? "环境变量" : "界面配置"}
                      </Tag>
                      <Tag>{server.kind === "http" ? "远程" : "本地"}</Tag>
                      <Tag
                        tone={
                          server.status === "connected"
                            ? "on"
                            : server.status === "error"
                              ? "err"
                              : "off"
                        }
                      >
                        {server.status === "connected"
                          ? `已连接 · ${server.toolCount} 工具`
                          : server.status === "disabled"
                            ? "已停用"
                            : "连接失败"}
                      </Tag>
                    </div>
                    <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                      {server.kind === "http"
                        ? (server.url ?? "")
                        : `${server.command} ${server.args.join(" ")}`}
                    </p>
                    {server.envKeys.length > 0 ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        环境变量：{server.envKeys.join(", ")}（值不回显）
                      </p>
                    ) : null}
                    {server.error ? (
                      <p className="mt-1 text-xs text-destructive">
                        {server.error}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void act(server, "reconnect")}
                      /* 环境变量提供的条目是只读的：重连会打到需要管理员 id 的端点上（点了必失败） */
                      disabled={busy === key || !server.id}
                      title={
                        server.id ? "重连" : "由环境变量配置，在这里无法重连"
                      }
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      重连
                    </button>
                    {server.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void act(server, "toggle")}
                          disabled={busy === key}
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {server.enabled ? "停用" : "启用"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(server);
                            setEnvTouched(false);
                            setForm({
                              name: server.name,
                              kind: server.kind,
                              command: server.command,
                              url: server.url ?? "",
                              argsText: formatArgsText(server.args),
                              envText: "",
                            });
                          }}
                          disabled={busy === key}
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          aria-label={`删除 ${server.name}`}
                          onClick={() => void act(server, "delete")}
                          disabled={busy === key}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <span className="px-1 text-xs text-muted-foreground">
                        由环境变量提供
                      </span>
                    )}
                    {busy === key ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <section className="space-y-2 rounded-xl border p-3">
        <h3 className="text-sm font-medium">
          {editing ? `编辑「${editing.name}」` : "手动添加"}
        </h3>
        <div className="flex items-center gap-1.5">
          {(
            [
              { id: "stdio", label: "本地命令" },
              { id: "http", label: "远程端点" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={Boolean(editing)}
              data-active={form.kind === item.id}
              onClick={() => setForm((prev) => ({ ...prev, kind: item.id }))}
              className="rounded-md border px-2 py-1 text-xs transition-colors data-[active=true]:border-foreground data-[active=true]:bg-foreground data-[active=true]:text-background disabled:opacity-60"
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            aria-label="MCP 名称"
            placeholder="名称（字母数字 - _）"
            value={form.name}
            disabled={Boolean(editing)}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, name: event.target.value }))
            }
            className="rounded-md border px-2 py-1.5 text-sm outline-none disabled:opacity-60"
          />
          {form.kind === "http" ? (
            <input
              aria-label="MCP 远程端点 URL"
              placeholder="远程端点 URL（https://…）"
              value={form.url}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, url: event.target.value }))
              }
              className="rounded-md border px-2 py-1.5 font-mono text-sm outline-none"
            />
          ) : (
            <input
              aria-label="MCP 启动命令"
              placeholder="启动命令（npx / uvx / node …）"
              value={form.command}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, command: event.target.value }))
              }
              className="rounded-md border px-2 py-1.5 text-sm outline-none"
            />
          )}
        </div>
        {form.kind === "stdio" ? (
          <>
            <textarea
              aria-label="MCP 参数"
              placeholder="每行一个参数"
              value={form.argsText}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, argsText: event.target.value }))
              }
              rows={3}
              className="w-full rounded-md border px-2 py-1.5 font-mono text-xs outline-none"
            />
            <textarea
              aria-label="MCP 环境变量"
              placeholder={
                editing && editing.envKeys.length > 0
                  ? `每行 KEY=VALUE · 留空保留 ${editing.envKeys.join("、")}`
                  : "每行 KEY=VALUE"
              }
              value={form.envText}
              onChange={(event) => {
                setEnvTouched(true);
                setForm((prev) => ({ ...prev, envText: event.target.value }));
              }}
              rows={2}
              className="w-full rounded-md border px-2 py-1.5 font-mono text-xs outline-none"
            />
          </>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy !== null}
            className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            {busy !== null ? "保存中…" : editing ? "保存并重连" : "添加"}
          </button>
          {editing ? (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setForm(EMPTY_FORM);
                setEnvTouched(false);
              }}
              className="rounded-md border px-3 py-1.5 text-sm"
            >
              取消编辑
            </button>
          ) : (
            <button
              type="button"
              onClick={onChanged}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新状态
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

/* ────────────────────────── 推荐（内置目录） ────────────────────────── */

function CuratedTab({
  busy,
  authHeaders,
  onCreate,
}: {
  busy: string | null;
  authHeaders: () => Record<string, string>;
  onCreate: (payload: McpCreatePayload) => Promise<boolean>;
}) {
  const [entries, setEntries] = useState<McpCuratedServer[]>([]);
  const [values, setValues] = useState<Record<string, Record<string, string>>>(
    {},
  );
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`${getServerBaseUrl()}/api/mcp/catalog`, {
      headers: authHeaders(),
    })
      .then(async (response) => {
        if (!response.ok) {
          // 不静默成空列表：失败要能看出来（曾因漏带鉴权头而"看起来没有内容"）
          setLocalError(`内置目录加载失败（HTTP ${response.status}）。`);
          return;
        }
        const data = (await response.json()) as { servers: McpCuratedServer[] };
        setEntries(data.servers);
      })
      .catch(() => setLocalError("内置目录加载失败（网络）。"));
  }, [authHeaders]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        离线可用 · 需本机装 Node（npx）或 Python（uv/uvx）
      </p>
      {localError ? (
        <p className="text-xs text-destructive">{localError}</p>
      ) : null}

      <ul className="space-y-2">
        {entries.map((entry) => {
          const entryValues = values[entry.id] ?? {};
          return (
            <li
              key={entry.id}
              className="rounded-xl border p-3 transition-colors hover:border-foreground/30"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{entry.title}</span>
                    <Tag>
                      {entry.requires === "node" ? "需 Node" : "需 Python"}
                    </Tag>
                    {entry.envKeys?.map((keyName) => (
                      <Tag key={keyName} tone="err">
                        需 {keyName}
                      </Tag>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {entry.description}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground/70">
                    {entry.command} {entry.argsTemplate.join(" ")}
                  </p>
                  {entry.params.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {entry.params.map((param) => (
                        <input
                          key={param.key}
                          aria-label={`${entry.title} ${param.label}`}
                          placeholder={`${param.label}（如 ${param.example}）`}
                          value={entryValues[param.key] ?? ""}
                          onChange={(event) =>
                            setValues((prev) => ({
                              ...prev,
                              [entry.id]: {
                                ...(prev[entry.id] ?? {}),
                                [param.key]: event.target.value,
                              },
                            }))
                          }
                          className="w-full rounded-md border px-2 py-1 text-xs outline-none"
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const { payload, missing } = buildCuratedServerPayload(
                      entry,
                      entryValues,
                    );
                    if (missing.length > 0) {
                      setLocalError(`请先填写：${missing.join("、")}`);
                      return;
                    }
                    setLocalError(null);
                    void onCreate(payload);
                  }}
                  disabled={busy !== null}
                  className="shrink-0 rounded-md border px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  {busy === entry.name ? "添加中…" : "添加"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ────────────────────────── 官方注册表 ────────────────────────── */

function RegistryTab({
  busy,
  authHeaders,
  onCreate,
}: {
  busy: string | null;
  authHeaders: () => Record<string, string>;
  onCreate: (payload: McpCreatePayload) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [servers, setServers] = useState<McpRegistryServer[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    (rawQuery: string, isRetry = false) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        q: rawQuery.trim(),
        limit: "20",
      });
      /**
       * 注册表是外部服务，服务端首次取（冷启动）或上游瞬时会失败——一次失败就直接
       * 报「检索失败」会让人以为功能坏了（用户已反馈过）。这里**自动重试一次**，
       * 再失败才把错误摆出来；用户手动改检索词时重新计时。
       */
      const fail = (message: string) => {
        if (!isRetry) {
          window.setTimeout(() => search(rawQuery, true), 1500);
          return;
        }
        setError(message);
      };
      void fetch(`${getServerBaseUrl()}/api/mcp/registry?${params}`, {
        headers: authHeaders(),
      })
        .then(async (response) => {
          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as {
              error?: { message?: string };
            };
            fail(payload.error?.message ?? "市场检索失败。");
            return;
          }
          const payload = (await response.json()) as {
            servers: McpRegistryServer[];
            count: number;
          };
          setServers(payload.servers);
          setCount(payload.count);
        })
        .catch(() => fail("市场请求失败，请检查网络。"))
        .finally(() => setLoading(false));
    },
    [authHeaders],
  );

  useEffect(() => {
    search("");
  }, [search]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        本地包（npm / Python）与远程端点（HTTP/SSE）都可添加
      </p>

      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            aria-label="搜索官方注册表"
            placeholder="搜索服务名（如 github）"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") search(query);
            }}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => search(query)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-40"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {loading ? "搜索中" : "搜索"}
        </button>
      </div>

      {loading ? (
        <ListLoading label="正在检索 MCP 市场…" rows={3} />
      ) : error ? (
        <ListError message={error} hint="网络不可用时用「推荐」" />
      ) : (
        <>
          {count > 0 ? (
            <p className="text-xs text-muted-foreground">共 {count} 条</p>
          ) : null}
          {servers.length === 0 ? (
            <ListEmpty title="没有匹配的服务" hint="换个更短的关键词" />
          ) : (
            <ul className="space-y-2">
              {servers.map((server) => (
                <li
                  key={`${server.name}@${server.version}`}
                  className="rounded-xl border p-3 transition-colors hover:border-foreground/30"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">
                          {server.name}
                        </span>
                        {server.version ? <Tag>v{server.version}</Tag> : null}
                        {server.installable ? (
                          <>
                            {server.kind === "http" ? <Tag>远程</Tag> : null}
                            <Tag tone="on">可添加</Tag>
                          </>
                        ) : (
                          <Tag tone="err">暂不支持</Tag>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {server.description || "（无描述）"}
                      </p>
                      <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground/70">
                        {server.installable
                          ? server.kind === "http"
                            ? (server.suggestedUrl ?? "")
                            : `${server.suggestedCommand} ${server.suggestedArgs.join(" ")}`
                          : (server.unsupportedReason ?? "")}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!server.installable || busy !== null}
                      title={
                        server.installable
                          ? "添加这个 MCP 服务"
                          : (server.unsupportedReason ?? "")
                      }
                      onClick={() => {
                        if (server.kind === "http") {
                          if (!server.suggestedUrl) return;
                          void onCreate({
                            name: server.suggestedName,
                            kind: "http",
                            url: server.suggestedUrl,
                          });
                          return;
                        }
                        if (!server.suggestedCommand) return;
                        void onCreate({
                          name: server.suggestedName,
                          kind: "stdio",
                          command: server.suggestedCommand,
                          args: server.suggestedArgs,
                        });
                      }}
                      className="shrink-0 rounded-md border px-3 py-1.5 text-xs disabled:opacity-40"
                    >
                      {busy === server.suggestedName ? "添加中…" : "添加"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Tag({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "on" | "off" | "err";
}) {
  const toneClass =
    tone === "on"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : tone === "err"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "text-muted-foreground";
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[11px] ${toneClass}`}
    >
      {children}
    </span>
  );
}
