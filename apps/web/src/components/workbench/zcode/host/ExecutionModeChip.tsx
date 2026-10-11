import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { Button } from "@zui/components/ui/button.js";
import { surfaceJson } from "./surfaceApi.js";

/**
 * 六档执行模式 chip（G2/Q7，KenFutWork 宿主件，非上游移植）。
 *
 * 复用 Design 侧同一缝：GET/PUT /api/execution-modes/:threadId——store 按
 * thread_id 或 chat_sessions.id 双 alias 匹配，Code 根会话两者同为 sessionId。
 * 服务端 runTurn 派发前 hydrate，工具门/pre-step 引导/自动化分场景全部生效。
 * Q6 合并规则：选「计划」联动把 ZCode 协作档切到 plan；其余六档不干预四档。
 * 端点不可用/加载失败时整体隐藏，不摆空壳。
 */
type ModeId = "agent" | "plan" | "solo" | "goal" | "loop" | "creative";

interface ExecutionModeChipProps {
  sessionId: string | null;
  disabled: boolean;
  onSwitchMode?: (mode: string) => void;
}

export function ExecutionModeChip({
  sessionId,
  disabled,
  onSwitchMode,
}: ExecutionModeChipProps) {
  const [modes, setModes] = useState<
    Array<{ id: ModeId; label: string }> | null
  >(null);
  const [mode, setMode] = useState<ModeId | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setModes(null);
    setMode(null);
    if (!sessionId) return;
    let alive = true;
    void (async () => {
      try {
        const [list, current] = await Promise.all([
          surfaceJson<{ modes: Array<{ id: ModeId; label: string }> }>(
            "/api/execution-modes",
          ),
          surfaceJson<{ mode: ModeId }>(
            `/api/execution-modes/${encodeURIComponent(sessionId)}`,
          ),
        ]);
        if (!alive) return;
        setModes(list.modes);
        setMode(current.mode);
      } catch {
        // 端点不可用或会话无对应行 → 隐藏 chip，不阻塞 composer
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const select = useCallback(
    async (next: string) => {
      if (!sessionId || saving) return;
      const previous = mode;
      const nextMode = next as ModeId;
      setMode(nextMode);
      setSaving(true);
      try {
        await surfaceJson(`/api/execution-modes/${encodeURIComponent(sessionId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: nextMode }),
        });
        if (nextMode === "plan") onSwitchMode?.("plan");
      } catch {
        if (previous) setMode(previous);
      } finally {
        setSaving(false);
      }
    },
    [mode, onSwitchMode, saving, sessionId],
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
          aria-label="执行模式"
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
