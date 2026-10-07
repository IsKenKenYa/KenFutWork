"use client";

import type { LocalAccessClient } from "@kenfutwork/shared";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  createLocalAccessClient,
  fetchLocalAccessClients,
  revokeLocalAccessClient,
} from "@/lib/local-access-api";

export function LocalAccessClientsSection() {
  const [tokens, setTokens] = useState<LocalAccessClient[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchLocalAccessClients()
      .then((data) => setTokens(data.clients))
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : "读取令牌失败。"),
      );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section aria-label="外部应用授权设置">
      <h3 className="mb-1 text-base font-medium">外部应用授权</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        外部应用 · 脚本 · CI 本机授权
      </p>

      <div className="flex items-center gap-2">
        <input
          aria-label="令牌名字"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="名称 · 如 CI 部署"
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
                const result = await createLocalAccessClient(name.trim());
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
            令牌仅显示一次 · 请复制保存
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
            没有令牌
          </li>
        ) : null}
        {tokens.map((token) => (
          <li key={token.id} className="flex items-center gap-3 px-3 py-2">
            <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">
                {token.label}
                {token.revokedAt ? (
                  <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    已吊销
                  </span>
                ) : null}
              </span>
              <span className="block font-mono text-xs text-muted-foreground">
                {token.kind === "api"
                  ? "脚本"
                  : token.kind === "browser"
                    ? "浏览器"
                    : "桌面"}{" "}
                · 创建于 {token.createdAt.slice(0, 16).replace("T", " ")}
              </span>
            </span>
            {!token.revokedAt ? (
              <button
                type="button"
                aria-label={`吊销令牌 ${token.label}`}
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      `吊销「${token.label}」？用它的外部应用会立刻失效。`,
                    )
                  ) {
                    return;
                  }
                  void (async () => {
                    setBusy(true);
                    try {
                      await revokeLocalAccessClient(token.id);
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
        撤销后需要重新连接
      </p>

      {notice ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
