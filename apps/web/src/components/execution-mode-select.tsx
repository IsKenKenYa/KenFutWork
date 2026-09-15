"use client";

import type { ExecutionMode } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchExecutionMode,
  fetchExecutionModes,
  updateExecutionMode,
} from "@/lib/server-api";

/**
 * 执行模式切换（P7 切换 UI，DEC-2/DEC-3）：
 * 会话级（threadId）激活 agent / plan 模式。端点不可用或加载失败时整体隐藏，
 * 不阻塞会话流。仅在有活跃会话时由 chat-sidebar 挂载。
 */
export function ExecutionModeSelect({
  accessToken,
  threadId,
}: {
  accessToken: string;
  threadId: string;
}) {
  const [modes, setModes] = useState<Array<{
    id: ExecutionMode;
    label: string;
    description: string;
  }> | null>(null);
  const [mode, setMode] = useState<ExecutionMode | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, current] = await Promise.all([
        fetchExecutionModes(accessToken),
        fetchExecutionMode(accessToken, threadId),
      ]);
      setModes(list.modes);
      setMode(current.mode);
    } catch {
      // 端点不可用（旧服务端/网络失败）→ 隐藏切换器，不阻塞会话
      setModes(null);
    }
  }, [accessToken, threadId]);

  useEffect(() => {
    setMode(null);
    void load();
  }, [load]);

  const handleChange = async (next: string) => {
    const previous = mode;
    setMode(next as ExecutionMode);
    setSaving(true);
    try {
      await updateExecutionMode(accessToken, threadId, {
        mode: next as ExecutionMode,
      });
    } catch {
      setMode(previous);
    } finally {
      setSaving(false);
    }
  };

  if (!modes || modes.length === 0 || !mode) {
    return null;
  }

  return (
    <div
      /* 左右留白交给父容器：自己再带 px-3 会和父级间距叠成一段空档（用户反馈「中间缝隙」） */
      className="flex items-center gap-1.5 py-1.5"
      data-testid="execution-mode-select"
    >
      <label htmlFor="execution-mode" className="text-xs text-muted-foreground">
        模式
      </label>
      <Select
        value={mode}
        disabled={saving}
        onValueChange={(next) => {
          if (typeof next === "string") void handleChange(next);
        }}
        items={modes.map((m) => ({ value: m.id, label: m.label }))}
      >
        <SelectTrigger
          id="execution-mode"
          aria-label="模式"
          className="px-2 py-1 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {modes.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {saving ? (
        <span className="text-xs text-muted-foreground">保存中…</span>
      ) : null}
    </div>
  );
}
