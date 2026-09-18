"use client";

import type { ApiTokenRecord } from "@kenfutwork/shared";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  createApiToken,
  fetchApiTokens,
  revokeApiToken,
} from "@/lib/server-api";

/**
 * 设置 → 外部应用授权（R5-2 的「外部应用授权」条目）。
 *
 * 形态：给外部应用 / 脚本 / CI 用的**个人访问令牌**——拿它调本服务的 HTTP API，
 * 权限与登录会话同源（同一个工作区隔离）。
 *
 * 四条红线在界面上如实写清，别让用户以为它和口令一样：
 * ① 明文**只显示一次**（库里只存 sha256，忘了就吊销重发）；② 可以即时吊销；
 * ③ 令牌不能签发令牌（这一页要登录会话才能用）；④ 记 last used 但不记来源 IP。
 */
export function ApiTokensSection({ accessToken }: { accessToken: string }) {
  const [tokens, setTokens] = useState<ApiTokenRecord[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchApiTokens(accessToken)
      .then((data) => setTokens(data.tokens))
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : "读取令牌失败。"),
      );
  }, [accessToken]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section aria-label="外部应用授权设置">
      <h3 className="mb-1 text-base font-medium">外部应用授权</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        给外部应用、脚本或 CI
        使用的访问令牌，权限与你登录时相同。令牌只显示一次，可随时吊销。
      </p>

      <div className="flex items-center gap-2">
        <input
          aria-label="令牌名字"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="名字，如：CI 部署"
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-sm outline-none"
        />
        <Button
          size="sm"
          disabled={busy || !name.trim()}
          onClick={() => {
            void (async () => {
              setBusy(true);
              setNotice(null);
              try {
                const result = await createApiToken(accessToken, name.trim());
                setCreated(result.token);
                setName("");
                refresh();
              } catch (error) {
                setNotice(
                  error instanceof Error ? error.message : "创建失败。",
                );
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          创建令牌
        </Button>
      </div>

      {/* 明文只出现这一次：给一个可复制的醒目块，离开就没了 */}
      {created ? (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="mb-1 text-xs text-amber-700 dark:text-amber-400">
            令牌只显示这一次，复制保存好；关闭后需要重新生成。
          </p>
          <code className="block break-all font-mono text-xs">{created}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(created);
              setNotice("已复制到剪贴板");
            }}
            className="mt-2 rounded-md border px-2 py-1 text-xs"
          >
            复制
          </button>
        </div>
      ) : null}

      <ul className="mt-3 divide-y rounded-lg border">
        {tokens.length === 0 ? (
          <li className="px-3 py-2 text-sm text-muted-foreground">
            还没有令牌。
          </li>
        ) : null}
        {tokens.map((token) => (
          <li key={token.id} className="flex items-center gap-3 px-3 py-2">
            <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">
                {token.name}
                {token.revokedAt ? (
                  <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    已吊销
                  </span>
                ) : null}
              </span>
              <span className="block font-mono text-[11px] text-muted-foreground">
                {token.tokenPrefix}…
                {token.lastUsedAt
                  ? ` · 最近使用 ${token.lastUsedAt.slice(0, 16).replace("T", " ")}`
                  : " · 从未使用"}
              </span>
            </span>
            {!token.revokedAt ? (
              <button
                type="button"
                aria-label={`吊销令牌 ${token.name}`}
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      `吊销「${token.name}」？用它的外部应用会立刻失效。`,
                    )
                  ) {
                    return;
                  }
                  void (async () => {
                    setBusy(true);
                    try {
                      await revokeApiToken(accessToken, token.id);
                      refresh();
                    } catch (error) {
                      setNotice(
                        error instanceof Error ? error.message : "吊销失败。",
                      );
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs text-muted-foreground">
        创建与吊销令牌需要登录会话。
      </p>

      {notice ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
