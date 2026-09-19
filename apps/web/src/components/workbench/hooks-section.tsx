"use client";

import type { WorkspaceSettings } from "@kenfutwork/shared";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { updateWorkspaceSettings } from "@/lib/server-api";

/**
 * 设置 → 钩子（R5-2「钩子」条目）。
 *
 * 在每一轮的**起点 / 终点**跑一条命令：不是提示词模板（那是「命令」页），而是真的
 * 在**项目工作目录**里执行的 shell 命令（典型用途：每轮结束格式化、跑一遍 lint）。
 *
 * 页面必须把三条边界写清楚，否则用户会以为是「给模型的执行面」：
 * ① 只有你能配，**模型无法新增或触发**（钩子不进工具注册表，也不受工具门管）；
 * ② 执行身份与目录同终端/agent（服务端进程身份 + 该项目的工作目录）；
 * ③ 失败**不影响本轮**，退出码与输出会作为一行出现在转录里。
 */
type HookRow = {
  id: string;
  event: "turn-start" | "turn-end";
  command: string;
};

const withRowIds = (hooks: WorkspaceSettings["hooks"]): HookRow[] =>
  hooks.map((hook) => ({ id: crypto.randomUUID(), ...hook }));

export function HooksSection({
  accessToken,
  hooks,
  onSaved,
}: {
  accessToken: string;
  hooks: WorkspaceSettings["hooks"];
  onSaved: (next: WorkspaceSettings["hooks"]) => void;
}) {
  const [rows, setRows] = useState<HookRow[]>(() => withRowIds(hooks));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    setRows(withRowIds(hooks));
  }, [hooks]);

  const save = async () => {
    const empty = rows.find((row) => !row.command.trim());
    if (empty) {
      setFeedback({ type: "error", message: "有一条钩子还没写命令。" });
      return;
    }
    setSaving(true);
    try {
      const result = await updateWorkspaceSettings(accessToken, {
        hooks: rows.map((row) => ({
          event: row.event,
          command: row.command.trim(),
        })),
      });
      onSaved(result.settings.hooks);
      setRows(withRowIds(result.settings.hooks));
      setFeedback({ type: "success", message: "已保存" });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "保存失败。",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="钩子设置">
      <h3 className="mb-1 text-base font-medium">钩子</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        在每轮对话开始或结束时，于工作目录里执行一条命令（例如自动格式化）。
        只有你能配置，失败也不影响本轮对话。
      </p>

      <div className="space-y-2">
        {rows.length === 0 ? (
          <p className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
            还没有钩子。点下面的「新增钩子」加一条。
          </p>
        ) : null}

        {rows.map((row, index) => (
          <div
            key={row.id}
            className="flex items-center gap-2 rounded-lg border p-2.5"
          >
            <select
              aria-label={`钩子时机 ${index + 1}`}
              value={row.event}
              onChange={(event) =>
                setRows((current) =>
                  current.map((item, i) =>
                    i === index
                      ? {
                          ...item,
                          event: event.target.value as
                            | "turn-start"
                            | "turn-end",
                        }
                      : item,
                  ),
                )
              }
              className="shrink-0 rounded-md border bg-transparent px-2 py-1 text-xs outline-none"
            >
              <option value="turn-start">本轮开始</option>
              <option value="turn-end">本轮结束</option>
            </select>
            <input
              aria-label={`钩子命令 ${index + 1}`}
              value={row.command}
              onChange={(event) =>
                setRows((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, command: event.target.value }
                      : item,
                  ),
                )
              }
              placeholder="例如：npx biome check ."
              className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 font-mono text-xs outline-none"
            />
            <button
              type="button"
              aria-label={`删除钩子 ${index + 1}`}
              onClick={() =>
                setRows((current) => current.filter((_, i) => i !== index))
              }
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() =>
            setRows((current) => [
              ...current,
              { id: crypto.randomUUID(), event: "turn-end", command: "" },
            ])
          }
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          新增钩子
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存钩子"}
        </button>
        {feedback ? (
          <span
            role="status"
            className={
              feedback.type === "error"
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {feedback.message}
          </span>
        ) : null}
      </div>
    </section>
  );
}
