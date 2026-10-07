"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  fetchInstanceSettings,
  updateInstanceSettings,
} from "@/lib/server-api";
import { SETTINGS_SECTION_GAP, SETTINGS_TITLE } from "@/lib/settings-layout";

/**
 * 规则与记忆（B：**真的接进提示词**）。
 *
 * 此前这里只写浏览器 localStorage——页面写着「这些指令会附加到 Agent 的每次请求中」，
 * 而服务端零消费方（`grep userRules` 无命中），是一段纯粹的摆设 UI。现在规则落
 * **工作区设置**，由 run 起始期拼进系统提示词（`formatUserRulesFragment`）。
 */
export function RulesMemorySection({
  accessToken = null,
}: {
  accessToken?: string | null | undefined;
}) {
  const [rules, setRules] = useState("");
  const [savedRules, setSavedRules] = useState("");
  const [entries, setEntries] = useState<string[]>([]);
  const [newEntry, setNewEntry] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchInstanceSettings(accessToken)
      .then((payload) => {
        if (cancelled) return;
        const view = payload.settings;
        setRules(view.userRules ?? "");
        setSavedRules(view.userRules ?? "");
        setEntries(view.ruleEntries ?? []);
      })
      .catch(() => {
        if (!cancelled) setStatus("读取规则失败，请稍后重试。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const handleSaveRules = async () => {
    setStatus(null);
    try {
      const payload = await updateInstanceSettings(accessToken, {
        userRules: rules,
      });
      const saved = payload.settings.userRules ?? "";
      setRules(saved);
      setSavedRules(saved);
      setStatus(saved.trim() ? "用户规则已保存" : "用户规则已清空");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存失败");
    }
  };

  const persistEntries = async (next: string[], message: string) => {
    const previous = entries;
    setEntries(next);
    setStatus(null);
    try {
      const payload = await updateInstanceSettings(accessToken, {
        ruleEntries: next,
      });
      setEntries(payload.settings.ruleEntries ?? []);
      setStatus(message);
    } catch (error) {
      setEntries(previous);
      setStatus(error instanceof Error ? error.message : "保存失败");
    }
  };

  const handleAddEntry = async () => {
    const trimmed = newEntry.trim();
    if (!trimmed || entries.includes(trimmed)) return;
    setNewEntry("");
    await persistEntries([...entries, trimmed], "规则条目已添加");
  };

  return (
    <section aria-label="规则与记忆设置" className={SETTINGS_SECTION_GAP}>
      <div>
        <h3 className={SETTINGS_TITLE}>用户规则</h3>
        <textarea
          aria-label="用户规则"
          value={rules}
          onChange={(event) => setRules(event.target.value)}
          rows={5}
          placeholder="例如：先给结论 · 改代码前跑测试"
          className="w-full rounded-md border px-3 py-2 text-sm"
          disabled={loading || !accessToken}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSaveRules()}
            disabled={loading || !accessToken || rules === savedRules}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            保存
          </button>
          {!accessToken ? (
            <span className="text-xs text-muted-foreground">未登录</span>
          ) : null}
        </div>
      </div>

      <div>
        <h3 className={SETTINGS_TITLE}>规则条目</h3>
        <div className="mb-2 flex items-center gap-2">
          <input
            aria-label="新规则条目"
            value={newEntry}
            onChange={(event) => setNewEntry(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleAddEntry();
              }
            }}
            placeholder="回车添加"
            className="min-w-0 flex-1 rounded-md border px-3 py-1.5 text-sm"
            disabled={!accessToken}
          />
          <button
            type="button"
            onClick={() => void handleAddEntry()}
            disabled={!accessToken || !newEntry.trim()}
            className="flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> 添加
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">还没有规则条目</p>
        ) : (
          <ul aria-label="规则条目列表" className="divide-y rounded-md border">
            {entries.map((entry) => (
              <li key={entry} className="flex items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 text-sm">{entry}</span>
                <button
                  type="button"
                  aria-label={`删除规则 ${entry}`}
                  onClick={() =>
                    void persistEntries(
                      entries.filter((item) => item !== entry),
                      "规则条目已删除",
                    )
                  }
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {status ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {status}
          </p>
        ) : null}
      </div>
    </section>
  );
}
