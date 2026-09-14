"use client";

import type {
  McpCuratedServer,
  McpRegistryServer,
  McpServerView,
} from "@loomic/shared";
import { Loader2, Plug, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
  command: "",
  argsText: "",
  envText: "",
};

type McpTab = "configured" | "curated" | "registry";

/**
 * MCP 管理弹窗（从「设置」挪到侧栏，与技能并列）。
 *
 * 三个页签：**已配置**（列表/启停/重连/编辑/删除 + 手动添加）、
 * **推荐**（内置精选目录，一键添加，参数就地填）、
 * **官方 MCP 市场**（registry.modelcontextprotocol.io 检索，仅 stdio+npm/pypi 可添加）。
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

  const readError = async (response: Response, fallback: string) => {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    return payload.error?.message ?? fallback;
  };

  /** 直接创建配置（推荐/注册表两个页签共用）。 */
  const createServer = useCallback(
    async (payload: {
      name: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }) => {
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
        setNotice(`已添加「${payload.name}」，可在「已配置」查看连接状态。`);
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
        <div className="flex items-center gap-3 border-b px-5 py-3 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base font-medium">
            <Plug className="h-4 w-4" /> MCP
          </DialogTitle>
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
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
                onClick={() => setTab(item.id)}
                className="rounded-md px-3 py-1 text-sm transition-colors data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:shadow-sm"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
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
        MCP server 以本机子进程运行，其工具以
        <code className="mx-1">mcp__&lt;server&gt;__&lt;tool&gt;</code>
        进入工具注册表；变更需要管理员。
      </p>

      {loading ? (
        <ListLoading label="正在加载已配置的 MCP server…" rows={2} />
      ) : servers.length === 0 ? (
        <ListEmpty
          title="尚未配置 MCP server"
          hint="去「推荐」一键添加，或在下方手动添加。"
        />
      ) : (
        <ul className="space-y-2">
          {servers.map((server) => {
            const key = server.id ?? server.name;
            return (
              <li key={key} className="rounded-xl border p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Plug className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm font-medium">{server.name}</span>
                      <Tag>
                        {server.source === "env" ? "环境变量" : "界面配置"}
                      </Tag>
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
                      {server.command} {server.args.join(" ")}
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
                      disabled={busy === key}
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
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
                              command: server.command,
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
                        由环境变量提供，界面只读
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
          <input
            aria-label="MCP 启动命令"
            placeholder="启动命令（npx / uvx / node …）"
            value={form.command}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, command: event.target.value }))
            }
            className="rounded-md border px-2 py-1.5 text-sm outline-none"
          />
        </div>
        <textarea
          aria-label="MCP 参数"
          placeholder={"参数（一行一个，含空格的值直接写整行）"}
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
              ? `环境变量（一行 KEY=VALUE；留空则保留已存的：${editing.envKeys.join(", ")}）`
              : "环境变量（一行 KEY=VALUE，可留空）"
          }
          value={form.envText}
          onChange={(event) => {
            setEnvTouched(true);
            setForm((prev) => ({ ...prev, envText: event.target.value }));
          }}
          rows={2}
          className="w-full rounded-md border px-2 py-1.5 font-mono text-xs outline-none"
        />
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
  onCreate: (payload: {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  }) => Promise<boolean>;
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
        内置常用
        server（离线可用）。添加后会在本机以子进程运行——请确认命令与参数。
        <code className="mx-1">requires=node</code> 需本机有 npx，
        <code className="mx-1">python</code> 需有 uv/uvx。
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
  onCreate: (payload: {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  }) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [servers, setServers] = useState<McpRegistryServer[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    (rawQuery: string) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        q: rawQuery.trim(),
        limit: "20",
      });
      void fetch(`${getServerBaseUrl()}/api/mcp/registry?${params}`, {
        headers: authHeaders(),
      })
        .then(async (response) => {
          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as {
              error?: { message?: string };
            };
            setError(payload.error?.message ?? "注册表检索失败。");
            return;
          }
          const payload = (await response.json()) as {
            servers: McpRegistryServer[];
            count: number;
          };
          setServers(payload.servers);
          setCount(payload.count);
        })
        .catch(() => setError("注册表请求失败（需要网络）。"))
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
        官方 MCP 市场：
        <code className="mx-1">registry.modelcontextprotocol.io</code>
        只做名称子串匹配，故检索词越短结果越多。当前只支持**本地 stdio**
        且包生态为 npm / pypi
        的条目；远程（HTTP/SSE）条目暂不支持，已在列表里标注。
      </p>

      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            aria-label="搜索官方注册表"
            placeholder="搜索 server 名称（如 filesystem / github / fetch）"
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
        <ListLoading label="正在检索官方 MCP 注册表…" rows={3} />
      ) : error ? (
        <ListError
          message={error}
          hint="注册表是外部服务；网络不可达时可在「推荐」里添加内置的常用 server。"
        />
      ) : (
        <>
          {count > 0 ? (
            <p className="text-xs text-muted-foreground">
              共 {count} 条（按官方接口返回计）
            </p>
          ) : null}
          {servers.length === 0 ? (
            <ListEmpty
              title="没有匹配的 server"
              hint="检索词越短结果越多（官方只做名称子串匹配）。"
            />
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
                          <Tag tone="on">可添加</Tag>
                        ) : (
                          <Tag tone="err">暂不支持</Tag>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {server.description || "（无描述）"}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground/70">
                        {server.installable
                          ? `${server.suggestedCommand} ${server.suggestedArgs.join(" ")}`
                          : (server.unsupportedReason ?? "")}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!server.installable || busy !== null}
                      title={
                        server.installable
                          ? "添加为本机 MCP server"
                          : (server.unsupportedReason ?? "")
                      }
                      onClick={() => {
                        if (!server.suggestedCommand) return;
                        void onCreate({
                          name: server.suggestedName,
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
