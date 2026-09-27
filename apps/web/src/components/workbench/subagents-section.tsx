"use client";

import type { WorkspaceSettings } from "@kenfutwork/shared";
import { Bot, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type AgentSubagentListResponse,
  fetchSubagents,
} from "@/lib/server-api";
import { SETTINGS_TITLE } from "@/lib/settings-layout";

/**
 * 设置 → 子智能体（风格 5：管理列表——可添加、可删除）。
 *
 * 三份来源，形状一致：
 * - **内置声明**（`GET /api/agent/subagents` 的 `subagents`，即 agent 装配用的那份）
 *   与框架分发工具（`builtin`）——只展示，不可删；
 * - **用户自定义**（工作区设置 `subagents`）——可添加、可删除，装配时按 name 追加。
 *
 * 与内置撞名的自定义项装配侧会丢弃，这里在添加时就地拒绝（不让用户造出「不会生效」的行）。
 */

type CustomSubagent = WorkspaceSettings["subagents"][number];

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const EMPTY_DRAFT: CustomSubagent = {
  name: "",
  label: "",
  description: "",
  systemPrompt: "",
};

export function SubagentsSection({
  accessToken,
  subagents,
  onSaved,
}: {
  accessToken: string;
  /** 工作区设置里的自定义子智能体（modal 状态，单一真相）。 */
  subagents: WorkspaceSettings["subagents"];
  /** 增删后回写 modal 状态（modal 统一走 PUT 部分更新）。 */
  onSaved: (next: WorkspaceSettings["subagents"]) => void;
}) {
  const [catalog, setCatalog] = useState<AgentSubagentListResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CustomSubagent>(EMPTY_DRAFT);
  const [draftOpen, setDraftOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSubagents(accessToken)
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "读取子智能体失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  /** 与内置声明撞名（或与现有自定义重名）都不许添加：装配不会生效或互相覆盖。 */
  function validate(next: CustomSubagent): string | null {
    if (!NAME_PATTERN.test(next.name)) {
      return "名字以字母开头，只能用字母、数字、- 与 _。";
    }
    const reserved = new Set([
      ...(catalog?.subagents ?? []).map((entry) => entry.name),
      "task",
    ]);
    if (reserved.has(next.name)) {
      return `名字「${next.name}」与内置子智能体撞名，换一个。`;
    }
    if (
      subagents.some(
        (entry) => entry.name.toLowerCase() === next.name.toLowerCase(),
      )
    ) {
      return `名字「${next.name}」已存在。`;
    }
    if (
      !next.label.trim() ||
      !next.description.trim() ||
      !next.systemPrompt.trim()
    ) {
      return "名称、派活依据与角色设定都不能为空。";
    }
    return null;
  }

  async function persist(next: WorkspaceSettings["subagents"]) {
    setSaving(true);
    setError(null);
    try {
      await onSaved(next);
      setDraft(EMPTY_DRAFT);
      setDraftOpen(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  function addDraft() {
    const next: CustomSubagent = {
      name: draft.name.trim(),
      label: draft.label.trim(),
      description: draft.description.trim(),
      systemPrompt: draft.systemPrompt.trim(),
    };
    const problem = validate(next);
    if (problem) {
      setError(problem);
      return;
    }
    if (subagents.length >= 10) {
      setError("最多 10 个自定义子智能体。");
      return;
    }
    void persist([...subagents, next]);
  }

  return (
    <section aria-label="子智能体设置">
      <h3 className={SETTINGS_TITLE}>子智能体</h3>

      {error ? (
        <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {!catalog ? (
        <p className="text-sm text-muted-foreground">正在读取…</p>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y rounded-lg border">
            {catalog.subagents.map((entry) => (
              <SubagentRow
                key={entry.name}
                name={entry.name}
                label={entry.label}
                description={entry.description}
              />
            ))}
            {catalog.custom.map((entry) => (
              <SubagentRow
                key={entry.name}
                name={entry.name}
                label={entry.label}
                description={entry.description}
                detail={`角色设定：${entry.systemPrompt}`}
                onDelete={() =>
                  void persist(
                    subagents.filter((item) => item.name !== entry.name),
                  )
                }
              />
            ))}
            {catalog.builtin.map((entry) => (
              <SubagentRow
                key={entry.name}
                name={entry.name}
                label={entry.label}
                description={entry.description}
              />
            ))}
          </ul>

          {draftOpen ? (
            <div className="space-y-2 rounded-lg border p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  aria-label="子智能体名字"
                  placeholder="名字（字母开头，如 translator）"
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, name: event.target.value }))
                  }
                  className="rounded-md border px-2 py-1.5 font-mono text-sm outline-none"
                />
                <input
                  aria-label="子智能体名称"
                  placeholder="名称（界面显示，如 翻译官）"
                  value={draft.label}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, label: event.target.value }))
                  }
                  className="rounded-md border px-2 py-1.5 text-sm outline-none"
                />
              </div>
              <input
                aria-label="子智能体派活依据"
                placeholder="派活依据：什么任务该交给它（模型据此分派）"
                value={draft.description}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    description: event.target.value,
                  }))
                }
                className="w-full rounded-md border px-2 py-1.5 text-sm outline-none"
              />
              <textarea
                aria-label="子智能体角色设定"
                placeholder="角色设定（system prompt）：它的行事方式与边界"
                value={draft.systemPrompt}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    systemPrompt: event.target.value,
                  }))
                }
                rows={3}
                className="w-full rounded-md border px-2 py-1.5 text-sm outline-none"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={addDraft}
                  className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-40"
                >
                  {saving ? "保存中…" : "添加"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraftOpen(false);
                    setDraft(EMPTY_DRAFT);
                  }}
                  className="rounded-md border px-3 py-1.5 text-sm"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={subagents.length >= 10}
              onClick={() => setDraftOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              添加子智能体
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 一行子智能体。**只两行**：标题（名称 + 派活 id）与一行说明。
 *
 * 曾经还有第三条「工具：generate_video」——两个近乎同形的 id 挤在一起
 * （`video_generate` 派活名 / `generate_video` 工具名）读起来是噪音，而且
 * 「按描述生成视频」这句说明已经把工具能力说清楚了；有工具的 77px、没工具的 58px
 * 还让同一列表行高不齐（真机量过）。
 */
function SubagentRow({
  name,
  label,
  description,
  detail,
  onDelete,
}: {
  name: string;
  label: string;
  description: string;
  /** 附加说明（只给自定义项：角色设定摘要）。 */
  detail?: string | null;
  /** 传入即渲染删除按钮（自定义项）。 */
  onDelete?: (() => void) | undefined;
}) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-sm">
          {label}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {name}
          </code>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        {detail ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {detail}
          </p>
        ) : null}
      </div>
      {onDelete ? (
        <button
          type="button"
          aria-label={`删除 ${label}`}
          onClick={onDelete}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </li>
  );
}
