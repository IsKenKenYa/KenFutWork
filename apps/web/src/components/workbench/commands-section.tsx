"use client";

import type { WorkspaceSettings } from "@kenfutwork/shared";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { updateWorkspaceSettings } from "@/lib/server-api";

/**
 * 设置 → 命令（R5-2 的「命令」条目）。
 *
 * 自定义斜杠命令：`名字 + 说明 + 提示词模板`，对话输入框里 `/名字 参数` 触发，
 * **提交前**展开成提示词（消费方在 `lib/slash-commands.ts`，工作台 composer 调用）。
 *
 * 保存是**整表覆盖**（这张表本来就是「一次编辑、整体保存」的形态）：新增/删除/改完
 * 点一次「保存命令」。校验与去重在服务端（契约层名字规则 + 读回时丢脏数据），
 * 这里先做前端能立刻给反馈的那部分（空名字/空提示词/重名）。
 */
/**
 * 编辑中的行：每条带一个**本地 id**（表单行的稳定身份）。没有它就只能拿下标当 key，
 * 删除/插入时 React 会复用错行的输入框（把上一条的文本挪到下一条）。
 */
type Row = { id: string; name: string; description: string; prompt: string };
const withRowIds = (list: WorkspaceSettings["commands"]): Row[] =>
  list.map((command) => ({ id: crypto.randomUUID(), ...command }));

export function CommandsSection({
  accessToken,
  commands,
  onSaved,
}: {
  accessToken: string;
  /** 工作区设置里的命令表（由设置模态统一读写，避免两处真相）。 */
  commands: WorkspaceSettings["commands"];
  onSaved: (next: WorkspaceSettings["commands"]) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => withRowIds(commands));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    setRows(withRowIds(commands));
  }, [commands]);

  const patch = (index: number, next: Partial<Row>) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...next } : row)),
    );
    setFeedback(null);
  };

  /** 前端能立刻判的问题（服务端仍会再校验一遍）。 */
  const validate = (): string | null => {
    const seen = new Set<string>();
    for (const row of rows) {
      const name = row.name.trim();
      if (!name) return "命令名不能为空。";
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) {
        return `「${name}」不是合法命令名：只能用字母、数字与连字符。`;
      }
      if (!row.prompt.trim()) return `「${name}」还没有写提示词。`;
      const key = name.toLowerCase();
      if (seen.has(key)) return `命令名「${name}」重复了。`;
      seen.add(key);
    }
    return null;
  };

  const save = async () => {
    const problem = validate();
    if (problem) {
      setFeedback({ type: "error", message: problem });
      return;
    }
    setSaving(true);
    try {
      const result = await updateWorkspaceSettings(accessToken, {
        commands: rows.map((row) => ({
          name: row.name.trim(),
          description: row.description.trim(),
          prompt: row.prompt.trim(),
        })),
      });
      onSaved(result.settings.commands);
      setRows(withRowIds(result.settings.commands));
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
    <section aria-label="命令设置">
      <h3 className="mb-1 text-base font-medium">命令</h3>

      <div className="space-y-2">
        {rows.length === 0 ? (
          <p className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
            没有命令
          </p>
        ) : null}

        {rows.map((row, index) => (
          <div key={row.id} className="space-y-1.5 rounded-lg border p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">/</span>
              <input
                aria-label={`命令名 ${index + 1}`}
                value={row.name}
                onChange={(event) => patch(index, { name: event.target.value })}
                placeholder="review"
                className="w-32 rounded-md border bg-transparent px-2 py-1 font-mono text-sm outline-none"
              />
              <input
                aria-label={`命令说明 ${index + 1}`}
                value={row.description}
                onChange={(event) =>
                  patch(index, { description: event.target.value })
                }
                placeholder="说明（可选）"
                className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-sm outline-none"
              />
              <button
                type="button"
                aria-label={`删除命令 ${index + 1}`}
                onClick={() => {
                  setRows((current) => current.filter((_, i) => i !== index));
                  setFeedback(null);
                }}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <textarea
              aria-label={`命令提示词 ${index + 1}`}
              value={row.prompt}
              onChange={(event) => patch(index, { prompt: event.target.value })}
              rows={2}
              placeholder={"请审查以下改动：{{args}}"}
              className="w-full resize-y rounded-md border bg-transparent px-2 py-1 text-sm outline-none"
            />
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setRows((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                name: "",
                description: "",
                prompt: "",
              },
            ]);
            setFeedback(null);
          }}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          新增命令
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存命令"}
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
