"use client";

import { AGENT_GOVERNANCE_LIMITS } from "@kenfutwork/shared";
import { useEffect, useRef, useState } from "react";
import {
  AGENT_GOVERNANCE_FIELDS,
  type AgentGovernanceInputs,
  type AgentGovernanceSettings,
  governanceInputValues,
  parseAgentGovernanceInputs,
} from "@/lib/agent-governance-settings";
import { SETTINGS_TITLE } from "@/lib/settings-layout";
import { Button } from "./ui/button";
import { Label } from "./ui/label";

interface AgentGovernanceSectionProps {
  initial: AgentGovernanceSettings;
  onSave: (next: AgentGovernanceSettings) => Promise<void>;
}

function useGovernanceForm({ initial, onSave }: AgentGovernanceSectionProps) {
  const [values, setValues] = useState(() => governanceInputValues(initial));
  const [infiniteRetry, setInfiniteRetry] = useState(initial.llmInfiniteRetry);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const mounted = useRef(false);
  const previousInitial = useRef(initial);
  const saveSequence = useRef(0);
  const saveInFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      saveSequence.current += 1;
    };
  }, []);
  useEffect(() => {
    const previous = previousInitial.current;
    previousInitial.current = initial;
    if (
      previous.llmInfiniteRetry === initial.llmInfiniteRetry &&
      AGENT_GOVERNANCE_FIELDS.every(({ key }) => previous[key] === initial[key])
    )
      return;
    setValues(governanceInputValues(initial));
    setInfiniteRetry(initial.llmInfiniteRetry);
  }, [initial]);
  const parsed = parseAgentGovernanceInputs(values, infiniteRetry);
  const hasChanges =
    parsed !== null &&
    (AGENT_GOVERNANCE_FIELDS.some(({ key }) => parsed[key] !== initial[key]) ||
      infiniteRetry !== initial.llmInfiniteRetry);
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!parsed || !hasChanges || saveInFlight.current) return;
    const sequence = ++saveSequence.current;
    const current = () => mounted.current && saveSequence.current === sequence;
    saveInFlight.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      await onSave(parsed);
      if (current())
        setFeedback({ type: "success", message: "Agent 治理设置已更新" });
    } catch (error) {
      if (current())
        setFeedback({
          type: "error",
          message:
            error instanceof Error ? error.message : "更新失败，请重试。",
        });
    } finally {
      saveInFlight.current = false;
      if (current()) setSaving(false);
    }
  }
  return {
    values,
    setValues,
    infiniteRetry,
    setInfiniteRetry,
    saving,
    feedback,
    hasChanges,
    handleSubmit,
  };
}

function GovernanceNumericField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: (typeof AGENT_GOVERNANCE_FIELDS)[number];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { min, max } = AGENT_GOVERNANCE_LIMITS[field.key];
  return (
    <div className="space-y-2">
      <Label htmlFor={field.key}>{field.label}</Label>
      <input
        id={field.key}
        aria-label={field.label}
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-28 rounded-md border px-2 py-1 text-sm outline-none"
      />
      <p className="text-xs text-muted-foreground">
        {field.hint} · 范围 {min}–{max}
      </p>
    </div>
  );
}

function InfiniteRetryField({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="space-y-1 rounded-lg border p-3">
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm">模型请求无限重试</span>
        <input
          type="checkbox"
          role="switch"
          aria-label="模型请求无限重试"
          aria-checked={checked}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-8 shrink-0 appearance-none rounded-full bg-muted transition-colors checked:bg-foreground/80 before:block before:h-3.5 before:w-3.5 before:translate-x-0.5 before:rounded-full before:background before:bg-background before:transition-transform checked:before:translate-x-4"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        可重试失败持续重试 · 取消即停止
      </p>
    </div>
  );
}

/** 纯治理表单；真实实例读取和部分保存由两种模式共用的数据绑定层持有。 */
export function AgentGovernanceSection(props: AgentGovernanceSectionProps) {
  const form = useGovernanceForm(props);
  const setValue = (key: keyof AgentGovernanceInputs, value: string) =>
    form.setValues((previous) => ({ ...previous, [key]: value }));
  return (
    <div>
      <h2 className={SETTINGS_TITLE}>Agent 治理</h2>
      <form onSubmit={form.handleSubmit} className="space-y-4 max-w-md">
        {AGENT_GOVERNANCE_FIELDS.map((field) => (
          <GovernanceNumericField
            key={field.key}
            field={field}
            value={form.values[field.key]}
            disabled={form.saving}
            onChange={(value) => setValue(field.key, value)}
          />
        ))}
        <InfiniteRetryField
          checked={form.infiniteRetry}
          disabled={form.saving}
          onChange={form.setInfiniteRetry}
        />
        {form.feedback && (
          <p
            role={form.feedback.type === "error" ? "alert" : "status"}
            className={`text-sm ${form.feedback.type === "success" ? "text-success" : "text-destructive"}`}
          >
            {form.feedback.message}
          </p>
        )}
        <Button
          type="submit"
          disabled={form.saving || !form.hasChanges}
          size="sm"
        >
          {form.saving ? "保存中…" : "保存"}
        </Button>
      </form>
    </div>
  );
}
