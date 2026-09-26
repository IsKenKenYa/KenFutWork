"use client";

import { useState } from "react";
import { Button } from "./ui/button";
import { Label } from "./ui/label";

/**
 * Agent 治理设置区（DEC-17/18）：子代理派生深度 / 后台并发 / LLM 请求重试 /
 * 无限重试开关 / execute 命令超时。数值语义与护栏的唯一属主是 shared
 * `governance.ts`——这里的 min/max 只是表单提示，服务端读侧还有一道钳制。
 */

interface AgentGovernanceSectionProps {
  initial: {
    subagentMaxDepth: number;
    subagentMaxConcurrency: number;
    llmRequestMaxRetries: number;
    llmInfiniteRetry: boolean;
    executeTimeoutMs: number;
  };
  onSave: (next: {
    subagentMaxDepth: number;
    subagentMaxConcurrency: number;
    llmRequestMaxRetries: number;
    llmInfiniteRetry: boolean;
    executeTimeoutMs: number;
  }) => Promise<void>;
}

const NUMERIC_FIELDS = [
  {
    key: "subagentMaxDepth",
    label: "子代理派生深度",
    hint: "子代理可以再派生几层；1 = 不允许子代理派生子代理。",
    min: 1,
    max: 4,
  },
  {
    key: "subagentMaxConcurrency",
    label: "后台任务并发上限",
    hint: "同时运行的后台子代理 / 长命令数量上限。",
    min: 1,
    max: 16,
  },
  {
    key: "llmRequestMaxRetries",
    label: "模型请求重试次数",
    hint: "上游 429/5xx 抖动时最多尝试几次（含首次），0 表示不重试。",
    min: 0,
    max: 100,
  },
  {
    key: "executeTimeoutMs",
    label: "命令超时（毫秒）",
    hint: "Code 模式后台命令的超时上限；5000–1800000。",
    min: 5_000,
    max: 1_800_000,
  },
] as const;

export function AgentGovernanceSection({
  initial,
  onSave,
}: AgentGovernanceSectionProps) {
  const [values, setValues] = useState({
    subagentMaxDepth: String(initial.subagentMaxDepth),
    subagentMaxConcurrency: String(initial.subagentMaxConcurrency),
    llmRequestMaxRetries: String(initial.llmRequestMaxRetries),
    executeTimeoutMs: String(initial.executeTimeoutMs),
  });
  const [infiniteRetry, setInfiniteRetry] = useState(initial.llmInfiniteRetry);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const parsed = {
    subagentMaxDepth: Number.parseInt(values.subagentMaxDepth, 10),
    subagentMaxConcurrency: Number.parseInt(values.subagentMaxConcurrency, 10),
    llmRequestMaxRetries: Number.parseInt(values.llmRequestMaxRetries, 10),
    executeTimeoutMs: Number.parseInt(values.executeTimeoutMs, 10),
  };
  const valid = NUMERIC_FIELDS.every(
    ({ key, min, max }) =>
      Number.isInteger(parsed[key]) && parsed[key] >= min && parsed[key] <= max,
  );
  const hasChanges =
    valid &&
    (parsed.subagentMaxDepth !== initial.subagentMaxDepth ||
      parsed.subagentMaxConcurrency !== initial.subagentMaxConcurrency ||
      parsed.llmRequestMaxRetries !== initial.llmRequestMaxRetries ||
      parsed.executeTimeoutMs !== initial.executeTimeoutMs ||
      infiniteRetry !== initial.llmInfiniteRetry);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setFeedback(null);
    try {
      await onSave({
        subagentMaxDepth: parsed.subagentMaxDepth,
        subagentMaxConcurrency: parsed.subagentMaxConcurrency,
        llmRequestMaxRetries: parsed.llmRequestMaxRetries,
        llmInfiniteRetry: infiniteRetry,
        executeTimeoutMs: parsed.executeTimeoutMs,
      });
      setFeedback({ type: "success", message: "Agent 治理设置已更新" });
    } catch {
      setFeedback({ type: "error", message: "更新失败，请重试。" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Agent 治理</h2>
      <p className="text-sm text-muted-foreground mb-6">
        子代理与后台任务的行为限额。key 是你自己的，限额由你定。
      </p>

      <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
        {NUMERIC_FIELDS.map((field) => (
          <div key={field.key} className="space-y-2">
            <Label htmlFor={field.key}>{field.label}</Label>
            <input
              id={field.key}
              aria-label={field.label}
              type="number"
              min={field.min}
              max={field.max}
              value={values[field.key]}
              onChange={(event) =>
                setValues((prev) => ({
                  ...prev,
                  [field.key]: event.target.value,
                }))
              }
              className="w-28 rounded-md border px-2 py-1 text-sm outline-none"
            />
            <p className="text-xs text-muted-foreground">{field.hint}</p>
          </div>
        ))}

        <div className="space-y-1 rounded-lg border p-3">
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm">模型请求无限重试</span>
            <input
              type="checkbox"
              role="switch"
              aria-label="模型请求无限重试"
              aria-checked={infiniteRetry}
              checked={infiniteRetry}
              onChange={(event) => setInfiniteRetry(event.target.checked)}
              className="h-4 w-8 shrink-0 appearance-none rounded-full bg-muted transition-colors checked:bg-foreground/80 before:block before:h-3.5 before:w-3.5 before:translate-x-0.5 before:rounded-full before:background before:bg-background before:transition-transform checked:before:translate-x-4"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            开启后可重试的失败（429/5xx/超时）会一直重试直到成功，避免不稳定上游卡住任务；仍然只重试可重试错误，取消立即生效。
          </p>
        </div>

        {feedback && (
          <p
            className={`text-sm ${feedback.type === "success" ? "text-success" : "text-destructive"}`}
          >
            {feedback.message}
          </p>
        )}

        <Button type="submit" disabled={saving || !hasChanges} size="sm">
          {saving ? "保存中…" : "保存"}
        </Button>
      </form>
    </div>
  );
}
