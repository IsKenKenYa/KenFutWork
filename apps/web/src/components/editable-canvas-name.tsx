"use client";

import type { CanvasDetail } from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { renameCanvas } from "@/lib/server-api";

interface EditableCanvasNameProps {
  accessToken: string | null;
  canvas: CanvasDetail;
  onRenamed: (canvas: CanvasDetail) => void;
}

/**
 * 画布名行内编辑。
 *
 * 位置就在三条杠右侧——用户把它当成「给这块画布起名」的地方（2026-10-20 用户两次
 * 反馈「画布命名功能好像没用」）。这里以前挂的是项目改名，写进去改的是项目，
 * 画布名不动，而且失败只 console.warn，看起来就像功能坏了。
 * 项目改名在侧栏项目行（ModeSidebarContent 的 ProjectRow）本来就有，不靠这里。
 */
export function EditableCanvasName({
  accessToken,
  canvas,
  onRenamed,
}: EditableCanvasNameProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(canvas.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) return;
    setName(canvas.name);
    setError(null);
  }, [canvas.name, editing]);

  const save = useCallback(async () => {
    const next = name.trim() || "未命名画布";
    setEditing(false);
    if (next === canvas.name || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await renameCanvas(
        accessToken,
        canvas.id,
        next,
        canvas.name,
        canvas.revision,
      );
      onRenamed(result.canvas);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "画布改名失败，请重试。",
      );
    } finally {
      setSaving(false);
    }
  }, [accessToken, canvas, name, onRenamed, saving]);

  const startEditing = useCallback(() => {
    setError(null);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }, []);

  if (editing) {
    return (
      <div className="flex flex-col">
        <input
          ref={inputRef}
          value={name}
          disabled={saving}
          maxLength={200}
          aria-label="画布名称"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => !saving && void save()}
          onKeyDown={(e) => {
            // 输入法组合态的 Enter 是确认候选/上屏，不是提交改名
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              setName(canvas.name);
              setError(null);
              setEditing(false);
            }
          }}
          className="h-8 rounded-lg bg-card border border-border px-2.5 text-sm font-medium text-foreground outline-none focus:ring-1 focus:ring-ring/20 max-w-[200px]"
        />
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      className="h-8 rounded-lg bg-transparent hover:bg-card px-2.5 text-sm font-medium text-foreground transition-colors truncate max-w-[200px] cursor-text"
      title={canvas.name}
    >
      {canvas.name}
    </button>
  );
}
