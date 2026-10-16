import type { ExecutionMode } from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

/**
 * 执行模式 chip（G2/Q7，KenFutWork 宿主件，非上游移植）。
 *
 * 复用 Design 侧同一缝：GET/PUT /api/execution-modes/:threadId——store 按
 * thread_id 或 chat_sessions.id 双 alias 匹配，Code 根会话两者同为 sessionId。
 * 宿主接纳输入时冻结策略；切换只影响之后发送的输入。
 * 「计划」联动独立规划态，离开时只关闭规划，不改变基础权限。
 * 端点不可用/加载失败时整体隐藏，不摆空壳。
 */
interface ExecutionModeChipProps {
  sessionId: string | null;
  disabled: boolean;
  onSwitchMode?: (mode: string) => void;
  onExecutionModeChange?: (mode: ExecutionMode) => void;
}

export function ExecutionModeChip({
  sessionId,
  disabled,
  onSwitchMode,
  onExecutionModeChange,
}: ExecutionModeChipProps) {
  const [modes, setModes] = useState<Array<{
    id: ExecutionMode;
    label: string;
  }> | null>(null);
  const [mode, setMode] = useState<ExecutionMode | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setModes(null);
    setMode(null);
    onExecutionModeChange?.("agent");
    if (!sessionId) return;
    let alive = true;
    void (async () => {
      try {
        const [list, current] = await Promise.all([
          surfaceJson<{ modes: Array<{ id: ExecutionMode; label: string }> }>(
            "/api/execution-modes",
          ),
          surfaceJson<{ mode: ExecutionMode }>(
            `/api/execution-modes/${encodeURIComponent(sessionId)}`,
          ),
        ]);
        if (!alive) return;
        setModes(list.modes);
        setMode(current.mode);
        onExecutionModeChange?.(current.mode);
      } catch {
        // 端点不可用或会话无对应行 → 隐藏 chip，不阻塞 composer
      }
    })();
    return () => {
      alive = false;
    };
  }, [onExecutionModeChange, sessionId]);

  const select = useCallback(
    async (next: string) => {
      if (!sessionId || saving) return;
      const previous = mode;
      const nextMode = next as ExecutionMode;
      setMode(nextMode);
      setSaving(true);
      try {
        await surfaceJson(
          `/api/execution-modes/${encodeURIComponent(sessionId)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: nextMode }),
          },
        );
        if (nextMode === "plan") onSwitchMode?.("plan");
        else if (previous === "plan") onSwitchMode?.("plan-off");
        onExecutionModeChange?.(nextMode);
      } catch {
        if (previous) setMode(previous);
      } finally {
        setSaving(false);
      }
    },
    [mode, onExecutionModeChange, onSwitchMode, saving, sessionId],
  );

  if (!modes || modes.length === 0 || !mode) return null;
  const label = modes.find((entry) => entry.id === mode)?.label ?? mode;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={disabled || saving}
          aria-label="执行策略"
          data-testid="execution-mode-chip"
        >
          {label}
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={mode} onValueChange={select}>
          {modes.map((entry) => (
            <DropdownMenuRadioItem key={entry.id} value={entry.id}>
              {entry.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
