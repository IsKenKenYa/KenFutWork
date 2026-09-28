"use client";

import type {
  AdminPlatformUsageResponse,
  AdminUserSummary,
  ProviderInstanceResponse,
  ProviderProtocol,
  SubscriptionPlan,
} from "@kenfutwork/shared";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createAdminProvider,
  deleteAdminProvider,
  fetchAdminMe,
  fetchAdminProviders,
  fetchAdminUsage,
  fetchAdminUsers,
  grantAdminCredits,
  setAdminUserPlan,
  setAdminUserRole,
  updateAdminProvider,
} from "@/lib/admin-api";
import { useAuth } from "@/lib/auth-context";
import { parseHeadersJson, providerHeadersHint } from "@/lib/provider-headers";

const PLANS: SubscriptionPlan[] = [
  "free",
  "starter",
  "pro",
  "ultra",
  "business",
];

const PROTOCOLS: ProviderProtocol[] = [
  "openai-compatible",
  "anthropic",
  "gemini",
  "volces",
  // 平台池也能配 Dify 引擎（工作区缺省时 flow 凭证回调回退到系统实例）
  "dify-engine",
];

const DEFAULT_MODELS_JSON = JSON.stringify(
  [{ id: "model-id", name: "展示名", capability: "chat" }],
  null,
  2,
);

/**
 * 平台管理后台（FORM-10）。普通用户看不到入口；即便直接访问 URL，
 * 服务端每个端点也会 403——前端只是把无权者挡在界面外。
 */
export default function AdminPage() {
  const { session, loading } = useAuth();
  const token = session?.access_token;

  const [access, setAccess] = useState<"checking" | "denied" | "ok">(
    "checking",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [providers, setProviders] = useState<ProviderInstanceResponse[]>([]);
  const [usage, setUsage] = useState<AdminPlatformUsageResponse | null>(null);

  const [grantAmounts, setGrantAmounts] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    name: "",
    protocol: "openai-compatible" as ProviderProtocol,
    baseUrl: "",
    apiKey: "",
    modelsJson: DEFAULT_MODELS_JSON,
    headersJson: "",
  });

  const refresh = useCallback(async (accessToken: string) => {
    const [nextUsers, nextProviders, nextUsage] = await Promise.all([
      fetchAdminUsers(accessToken),
      fetchAdminProviders(accessToken),
      fetchAdminUsage(accessToken),
    ]);
    setUsers(nextUsers.users);
    setProviders(nextProviders.instances);
    setUsage(nextUsage);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!token) {
      setAccess("denied");
      return;
    }
    let cancelled = false;
    void fetchAdminMe(token)
      .then((me) => {
        if (cancelled) return;
        setAccess(me.isAdmin ? "ok" : "denied");
        if (me.isAdmin) {
          void refresh(token).catch((err: unknown) =>
            setError(err instanceof Error ? err.message : "加载失败"),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setAccess("denied");
      });
    return () => {
      cancelled = true;
    };
  }, [loading, token, refresh]);

  /** 统一包裹一次管理动作：禁用按钮 → 执行 → 刷新 + 错误呈现。 */
  async function run(action: (accessToken: string) => Promise<unknown>) {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      await action(token);
      await refresh(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (access === "checking") {
    return (
      <main className="mx-auto max-w-3xl p-10 text-sm text-muted-foreground">
        正在校验权限…
      </main>
    );
  }

  if (access === "denied") {
    return (
      <main className="mx-auto max-w-3xl space-y-4 p-10">
        <h1 className="text-xl font-medium">无权访问</h1>
        <p className="text-sm text-muted-foreground">
          仅管理员可用 · 需要权限请联系管理员
        </p>
        <Link className="text-sm underline" href="/workbench">
          返回工作台
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium">平台管理后台</h1>
          <p className="text-sm text-muted-foreground">
            系统供应商分发 · 额度与套餐 · 用量总览
          </p>
        </div>
        <Link className="text-sm underline" href="/workbench">
          返回工作台
        </Link>
      </header>

      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* ── 用户 / 额度 / 套餐 ── */}
      <section className="space-y-3">
        <h2 className="text-base font-medium">用户与额度</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">账号</th>
                <th className="px-3 py-2">角色</th>
                <th className="px-3 py-2">套餐</th>
                <th className="px-3 py-2">余额</th>
                <th className="px-3 py-2">Tokens</th>
                <th className="px-3 py-2">额度调整</th>
                <th className="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.userId} className="border-t">
                  <td className="px-3 py-2">
                    <div className="font-medium">{user.email}</div>
                    <div className="text-xs text-muted-foreground">
                      {user.displayName ?? "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {user.role === "admin" ? "管理员" : "普通用户"}
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      aria-label={`套餐-${user.email}`}
                      value={user.plan}
                      onValueChange={(next) => {
                        if (typeof next !== "string") return;
                        void run((accessToken) =>
                          setAdminUserPlan(
                            accessToken,
                            user.userId,
                            next as SubscriptionPlan,
                          ),
                        );
                      }}
                      items={PLANS.map((plan) => ({
                        value: plan,
                        label: plan,
                      }))}
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLANS.map((plan) => (
                          <SelectItem key={plan} value={plan}>
                            {plan}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{user.balance}</td>
                  <td className="px-3 py-2 tabular-nums">{user.totalTokens}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`调整额度-${user.email}`}
                        className="w-24"
                        placeholder="如 500"
                        value={grantAmounts[user.userId] ?? ""}
                        onChange={(event) =>
                          setGrantAmounts((prev) => ({
                            ...prev,
                            [user.userId]: event.target.value,
                          }))
                        }
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          const raw = grantAmounts[user.userId] ?? "";
                          const amount = Number.parseInt(raw, 10);
                          if (!Number.isFinite(amount) || amount === 0) {
                            setError("请输入非零整数（正数发放、负数扣减）");
                            return;
                          }
                          void run((accessToken) =>
                            grantAdminCredits(
                              accessToken,
                              user.userId,
                              amount,
                              "管理后台调整",
                            ),
                          ).then(() =>
                            setGrantAmounts((prev) => ({
                              ...prev,
                              [user.userId]: "",
                            })),
                          );
                        }}
                      >
                        调整
                      </Button>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run((accessToken) =>
                          setAdminUserRole(
                            accessToken,
                            user.userId,
                            user.role === "admin" ? "user" : "admin",
                          ),
                        )
                      }
                    >
                      {user.role === "admin" ? "回收管理员" : "设为管理员"}
                    </Button>
                  </td>
                </tr>
              ))}
              {users.length === 0 ? (
                <tr>
                  <td
                    className="px-3 py-6 text-center text-muted-foreground"
                    colSpan={7}
                  >
                    暂无用户
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 系统供应商（平台池）── */}
      <section className="space-y-3">
        <h2 className="text-base font-medium">系统供应商（分发给全体用户）</h2>
        <p className="text-sm text-muted-foreground">
          平台池按 token 扣额度 · 自带 Key 不计费
        </p>
        <div className="space-y-2">
          {providers.map((instance) => (
            <div
              key={instance.id}
              className="flex items-center justify-between rounded-lg border px-3 py-2"
            >
              <div>
                <div className="text-sm font-medium">
                  {instance.name}
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    平台池
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {instance.protocol} · {instance.models.length} 个模型 ·{" "}
                  {instance.enabled ? "已启用" : "已停用"}
                </div>
                {instance.headerKeys.length > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    自定义请求头：{instance.headerKeys.join("、")}（值不回显）
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run((accessToken) =>
                      updateAdminProvider(accessToken, instance.id, {
                        enabled: !instance.enabled,
                      }),
                    )
                  }
                >
                  {instance.enabled ? "停用" : "启用"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run((accessToken) =>
                      deleteAdminProvider(accessToken, instance.id),
                    )
                  }
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有系统供应商</p>
          ) : null}
        </div>

        <form
          className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            let models: unknown;
            try {
              models = JSON.parse(form.modelsJson);
            } catch {
              setError("模型清单不是合法 JSON");
              return;
            }
            if (!Array.isArray(models) || models.length === 0) {
              setError("模型清单需为非空数组");
              return;
            }
            const headers = parseHeadersJson(form.headersJson);
            if (headers instanceof Error) {
              setError(headers.message);
              return;
            }
            void run((accessToken) =>
              createAdminProvider(accessToken, {
                name: form.name,
                protocol: form.protocol,
                ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}),
                apiKey: form.apiKey,
                models: models as ProviderInstanceResponse["models"],
                ...(headers ? { headers } : {}),
              }),
            ).then(() =>
              setForm((prev) => ({
                ...prev,
                name: "",
                apiKey: "",
                headersJson: "",
              })),
            );
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="provider-name">名称</Label>
            <Input
              id="provider-name"
              value={form.name}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, name: event.target.value }))
              }
              placeholder="如 平台 GLM 池"
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="provider-protocol">协议</Label>
            <Select
              aria-label="协议"
              value={form.protocol}
              onValueChange={(next) => {
                if (typeof next === "string") {
                  setForm((prev) => ({
                    ...prev,
                    protocol: next as ProviderProtocol,
                  }));
                }
              }}
              items={PROTOCOLS.map((p) => ({ value: p, label: p }))}
            >
              <SelectTrigger id="provider-protocol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROTOCOLS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="provider-base-url">Base URL</Label>
            <Input
              id="provider-base-url"
              value={form.baseUrl}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, baseUrl: event.target.value }))
              }
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="provider-api-key">API Key（只写不读）</Label>
            <Input
              id="provider-api-key"
              type="password"
              value={form.apiKey}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, apiKey: event.target.value }))
              }
              placeholder="平台侧 Key"
              required
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="provider-models">模型清单（JSON）</Label>
            <textarea
              id="provider-models"
              className="h-32 w-full rounded-lg border bg-transparent p-2 font-mono text-xs outline-none"
              value={form.modelsJson}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, modelsJson: event.target.value }))
              }
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="provider-headers">自定义请求头</Label>
            <textarea
              id="provider-headers"
              rows={2}
              className="w-full rounded-lg border bg-transparent p-2 font-mono text-xs outline-none"
              value={form.headersJson}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  headersJson: event.target.value,
                }))
              }
              placeholder='{"x-opencode-session":"{{sessionId}}"}'
            />
            <p className="text-xs text-muted-foreground">
              {providerHeadersHint} · 只作用于本实例
            </p>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              添加系统供应商
            </Button>
          </div>
        </form>
      </section>

      {/* ── 平台用量 ── */}
      <section className="space-y-3">
        <h2 className="text-base font-medium">平台用量</h2>
        {usage ? (
          <>
            <div className="flex gap-6 text-sm">
              <span>
                总 tokens：
                <span className="font-medium tabular-nums">
                  {usage.totals.totalTokens}
                </span>
              </span>
              <span>
                总成本：
                <span className="font-medium tabular-nums">
                  ${usage.totals.costUsd.toFixed(4)}
                </span>
              </span>
            </div>
            <div className="rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">账号</th>
                    <th className="px-3 py-2">Tokens</th>
                    <th className="px-3 py-2">成本</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byUser.map((row) => (
                    <tr key={row.userId} className="border-t">
                      <td className="px-3 py-2">{row.email}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {row.totalTokens}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        ${row.costUsd.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                  {usage.byUser.length === 0 ? (
                    <tr>
                      <td
                        className="px-3 py-6 text-center text-muted-foreground"
                        colSpan={3}
                      >
                        暂无用量
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">加载中…</p>
        )}
      </section>
    </main>
  );
}
