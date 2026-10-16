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
import { useCallback, useEffect, useRef, useState } from "react";
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
  planEnabled?: boolean;
  onSwitchMode?: (mode: string) => void;
  onExecutionModeChange?: (mode: ExecutionMode | undefined) => void;
}

export function ExecutionModeChip({
  sessionId,
  disabled,
  planEnabled,
  onSwitchMode,
  onExecutionModeChange,
}: ExecutionModeChipProps) {
  const [modes, setModes] = useState<Array<{
    id: ExecutionMode;
    label: string;
  }> | null>(null);
  const [mode, setMode] = useState<ExecutionMode | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const currentSession = useRef(sessionId);
  const onModeChange = useRef(onExecutionModeChange);
  currentSession.current = sessionId;
  onModeChange.current = onExecutionModeChange;

  useEffect(() => {
    const epoch = ++generation.current;
    setModes(null);
    setMode(null);
    setSaving(false);
    onModeChange.current?.(undefined);
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
        if (
          !alive ||
          epoch !== generation.current ||
          currentSession.current !== sessionId
        )
          return;
        setModes(list.modes);
        setMode(current.mode);
        onModeChange.current?.(current.mode);
      } catch {
        // 端点不可用或会话无对应行 → 隐藏 chip，不阻塞 composer
      }
    })();
    return () => {
      alive = false;
      generation.current += 1;
    };
  }, [sessionId]);

  const select = useCallback(
    async (next: string) => {
      if (!sessionId || saving) return;
      const previous = mode;
      const nextMode = next as ExecutionMode;
      const previousPlanning = planEnabled ?? previous === "plan";
      const nextPlanning =
        nextMode === "plan" ? true : previous === "plan" ? false : undefined;
      const epoch = generation.current;
      const isCurrent = () =>
        epoch === generation.current && currentSession.current === sessionId;
      setMode(nextMode);
      // 可见选择与本次点击意图同步；偏好落盘不阻塞发送。
      onModeChange.current?.(nextMode);
      if (nextPlanning !== undefined)
        onSwitchMode?.(nextPlanning ? "plan" : "plan-off");
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
        if (!isCurrent()) return;
      } catch {
        if (!isCurrent()) return;
        if (previous) {
          setMode(previous);
          onModeChange.current?.(previous);
          if (nextPlanning !== undefined)
            onSwitchMode?.(previousPlanning ? "plan" : "plan-off");
        }
      } finally {
        if (isCurrent()) setSaving(false);
      }
    },
    [mode, onSwitchMode, planEnabled, saving, sessionId],
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
