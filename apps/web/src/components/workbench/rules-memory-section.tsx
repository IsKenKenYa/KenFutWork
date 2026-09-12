"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

/** 规则与记忆：用户规则（附加到每次请求）+ 规则条目（本机持久化）。 */
const RULES_STORAGE_KEY = "workbench:user-rules";
const ENTRIES_STORAGE_KEY = "workbench:rule-entries";

function loadText(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function loadEntries(): string[] {
  try {
    const raw = window.localStorage.getItem(ENTRIES_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function saveText(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 存储失败不阻塞设置
  }
}

export function RulesMemorySection() {
  const [rules, setRules] = useState("");
  const [savedRules, setSavedRules] = useState("");
  const [entries, setEntries] = useState<string[]>([]);
  const [newEntry, setNewEntry] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const initial = loadText(RULES_STORAGE_KEY);
    setRules(initial);
    setSavedRules(initial);
    setEntries(loadEntries());
  }, []);

  const handleSaveRules = () => {
    saveText(RULES_STORAGE_KEY, rules);
    setSavedRules(rules);
    setStatus("用户规则已保存");
  };

  const handleAddEntry = () => {
    const trimmed = newEntry.trim();
    if (!trimmed) return;
    const next = [...entries, trimmed];
    setEntries(next);
    saveText(ENTRIES_STORAGE_KEY, JSON.stringify(next));
    setNewEntry("");
  };

  const handleRemoveEntry = (index: number) => {
    const next = entries.filter((_, i) => i !== index);
    setEntries(next);
    saveText(ENTRIES_STORAGE_KEY, JSON.stringify(next));
  };

  return (
    <section aria-label="规则与记忆">
      <h3 className="mb-1 text-base font-medium">用户规则</h3>
      <p className="mb-2 text-sm text-muted-foreground">
        这些指令会附加到 Agent 的每次请求中。
      </p>
      <textarea
        aria-label="用户规则"
        rows={4}
        placeholder="例如：回复请用中文；代码注释保留关键约束说明…"
        value={rules}
        onChange={(e) => setRules(e.target.value)}
        className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-2 flex items-center justify-end gap-3">
        {status ? (
          <span role="status" className="text-xs text-muted-foreground">
            {status}
          </span>
        ) : null}
        <button
          type="button"
          disabled={rules === savedRules}
          onClick={handleSaveRules}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          保存
        </button>
      </div>

      <h3 className="mt-6 mb-1 text-base font-medium">规则条目</h3>
      <p className="mb-2 text-sm text-muted-foreground">
        逐条管理的补充规则，与用户规则一同生效。
      </p>
      {entries.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">暂无规则条目</p>
      ) : (
        <ul className="mb-2 divide-y rounded-md border">
          {entries.map((entry, index) => (
            <li key={entry} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm">{entry}</span>
              <button
                type="button"
                aria-label={`删除规则 ${entry}`}
                onClick={() => handleRemoveEntry(index)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          aria-label="新规则条目"
          placeholder="添加一条规则，如「提交信息用中文」"
          value={newEntry}
          onChange={(e) => setNewEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAddEntry();
          }}
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          disabled={!newEntry.trim()}
          onClick={handleAddEntry}
          className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" /> 添加
        </button>
      </div>
    </section>
  );
}
