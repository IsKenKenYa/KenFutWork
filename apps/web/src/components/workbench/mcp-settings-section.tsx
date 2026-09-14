"use client";

import type { McpServerView } from "@loomic/shared";
import { Loader2, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { getServerBaseUrl } from "@/lib/env";
import {
  buildMcpServerPayload,
  formatArgsText,
  type McpServerFormInput,
} from "@/lib/mcp-form";

const EMPTY_FORM: McpServerFormInput = {
  name: "",
  command: "",
  argsText: "",
  envText: "",
};

/**
 * 设置 · MCP section：列出与运行状态、增删改、启停、重连。
 *
 * 新增能力（此前 MCP 只能靠 `LOOMIC_MCP_SERVERS` 环境变量，界面上看不到也改不了）：
 * - 来源分 `managed`（界面配置，可增删改）与 `env`（环境变量，只读，可重连）；
 * - 状态分 已连接（附工具数）/ 连接失败（附原因）/ 已停用；
 * - 密钥纪律：接口只回 `envKeys`，编辑时未重填则不下发 env（不覆盖已存值）。
 * 变更类操作需管理员（服务端 403 拦截，前端只做提示）。
 */
export function McpSettingsSection({ accessToken }: { accessToken: string }) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<McpServerFormInput>(EMPTY_FORM);
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [envTouched, setEnvTouched] = useState(false);

  const authHeaders = useCallback(
    (): Record<string, string> => ({ Authorization: `Bearer ${accessToken}` }),
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
    refresh();
  }, [refresh]);

  async function readError(response: Response, fallback: string) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    return payload.error?.message ?? fallback;
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
      refresh();
    } catch {
      setError("保存请求失败。");
    } finally {
      setBusy(null);
    }
  }

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
      refresh();
    } catch {
      setError("操作请求失败。");
    } finally {
      setBusy(null);
    }
  }

  function startEdit(server: McpServerView) {
    setEditing(server);
    setEnvTouched(false);
    setForm({
      name: server.name,
      command: server.command,
      argsText: formatArgsText(server.args),
      envText: "",
    });
    setNotice(null);
    setError(null);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">MCP server</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          以 stdio 方式连接 MCP server，其工具会以
          <code className="mx-1">mcp__&lt;server&gt;__&lt;tool&gt;</code>
          进入统一工具注册表。变更类操作需要管理员（会在本机启动子进程）。
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">尚未配置 MCP server。</p>
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
                          onClick={() => startEdit(server)}
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

      {notice ? <p className="text-xs text-emerald-600">{notice}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <section className="space-y-2 rounded-xl border p-3">
        <h3 className="text-sm font-medium">
          {editing ? `编辑「${editing.name}」` : "添加 MCP server"}
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
            placeholder="启动命令（如 npx / python / node）"
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
              onClick={refresh}
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
        ? "border-red-200 bg-red-50 text-red-700"
        : "text-muted-foreground";
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[11px] ${toneClass}`}
    >
      {children}
    </span>
  );
}
