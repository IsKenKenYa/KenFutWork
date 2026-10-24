import type { ExecutionMode } from "@kenfutwork/shared";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@zui/components/ui/dropdown-menu.js";
import {
  BotIcon,
  LightbulbIcon,
  type LucideIcon,
  MessageSquareIcon,
  PuzzleIcon,
  Repeat2Icon,
  TargetIcon,
  WorkflowIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

type ModeOption = { id: ExecutionMode; label: string };
const executionModeIcons: Partial<Record<ExecutionMode, LucideIcon>> = {
  agent: BotIcon,
  plan: LightbulbIcon,
  solo: MessageSquareIcon,
  goal: TargetIcon,
  loop: Repeat2Icon,
  creative: PuzzleIcon,
};
type ModeState = {
  sessionId: string | null;
  modes: ModeOption[] | null;
  mode: ExecutionMode | undefined;
  saving: boolean;
};
const emptyState = (sessionId: string | null): ModeState => ({
  sessionId,
  modes: null,
  mode: undefined,
  saving: false,
});

/** Composer持有唯一策略状态；显示、提交与明确关闭规划消费同一份意图。 */
export function useExecutionModeController({
  sessionId,
  planEnabled,
  onSwitchMode,
}: {
  sessionId: string | null;
  planEnabled?: boolean;
  onSwitchMode?: (mode: string) => void;
}) {
  const [storedState, setState] = useState(() => emptyState(sessionId));
  const state =
    storedState.sessionId === sessionId ? storedState : emptyState(sessionId);
  if (state !== storedState) setState(state);
  const stateRef = useRef(state);
  stateRef.current = state;
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const taskGeneration = useRef(0);
  const intentGeneration = useRef(0);
  const planning = useRef(planEnabled);
  planning.current = planEnabled;
  const switchMode = useRef(onSwitchMode);
  switchMode.current = onSwitchMode;
  const planClosed = useRef(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const update = useCallback(
    (patch: Partial<ModeState>) => {
      if (currentSession.current !== sessionId) return;
      const next = { ...stateRef.current, ...patch };
      stateRef.current = next;
      setState(next);
    },
    [sessionId],
  );
  const persist = useCallback(
    (targetSessionId: string, mode: ExecutionMode) => {
      // 后一次明确关闭必须排在旧偏好写入之后；本次发送不等待这个队列。
      const operation = writes.current
        .catch(() => {})
        .then(() =>
          surfaceJson(
            "/api/execution-modes/" + encodeURIComponent(targetSessionId),
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ mode }),
            },
          ),
        );
      writes.current = operation;
      return operation;
    },
    [],
  );

  useEffect(() => {
    const epoch = ++taskGeneration.current;
    intentGeneration.current += 1;
    planClosed.current = false;
    writes.current = Promise.resolve();
    update(emptyState(sessionId));
    if (!sessionId) return;
    let alive = true;
    void (async () => {
      try {
        const [list, current] = await Promise.all([
          surfaceJson<{ modes: ModeOption[] }>("/api/execution-modes"),
          surfaceJson<{ mode: ExecutionMode }>(
            "/api/execution-modes/" + encodeURIComponent(sessionId),
          ),
        ]);
        if (
          !alive ||
          epoch !== taskGeneration.current ||
          currentSession.current !== sessionId
        )
          return;
        update({
          modes: list.modes,
          mode:
            current.mode === "plan" && planClosed.current
              ? "agent"
              : current.mode,
        });
      } catch {
        // 端点不可用时隐藏菜单；明确关闭规划产生的本地意图仍用于发送。
      }
    })();
    return () => {
      alive = false;
      taskGeneration.current += 1;
    };
  }, [sessionId, update]);

  const select = useCallback(
    async (next: string) => {
      if (currentSession.current !== sessionId) return;
      const previous = stateRef.current.mode;
      if (!sessionId || stateRef.current.saving || !previous) return;
      const nextMode = next as ExecutionMode;
      const previousPlanning = planning.current ?? previous === "plan";
      const nextPlanning =
        nextMode === "plan" ? true : previous === "plan" ? false : undefined;
      const taskEpoch = taskGeneration.current;
      const intentEpoch = ++intentGeneration.current;
      const isCurrent = () =>
        currentSession.current === sessionId &&
        taskEpoch === taskGeneration.current &&
        intentEpoch === intentGeneration.current;
      planClosed.current = false;
      update({ mode: nextMode, saving: true });
      if (nextPlanning !== undefined)
        switchMode.current?.(nextPlanning ? "plan" : "plan-off");
      try {
        await persist(sessionId, nextMode);
      } catch {
        if (!isCurrent()) return;
        update({ mode: previous });
        if (nextPlanning !== undefined)
          switchMode.current?.(previousPlanning ? "plan" : "plan-off");
      } finally {
        if (isCurrent()) update({ saving: false });
      }
    },
    [persist, sessionId, update],
  );

  const switchCollaborationMode = useCallback(
    (next: string) => {
      if (currentSession.current !== sessionId) return;
      if (next === "plan" || next === "plan-off") {
        // 人工规划编辑拥有新代际，包含布尔值折返；旧PUT不能回滚它。
        intentGeneration.current += 1;
        planClosed.current = next === "plan-off";
        update({ saving: false });
        if (
          next === "plan-off" &&
          (stateRef.current.mode === "plan" ||
            stateRef.current.mode === undefined)
        ) {
          update({ mode: "agent" });
          if (sessionId) void persist(sessionId, "agent").catch(() => {});
        }
      }
      switchMode.current?.(next);
    },
    [persist, sessionId, update],
  );

  return useMemo(
    () => ({
      mode: state.mode,
      modes: state.modes,
      saving: state.saving,
      select,
      switchCollaborationMode,
    }),
    [select, state.mode, state.modes, state.saving, switchCollaborationMode],
  );
}

export type ExecutionModeController = ReturnType<
  typeof useExecutionModeController
>;

/** 受控选项：执行方式全档（含「计划」）在此单选；planEnabled 仍由 controller 与 Composer 双向同步。 */
export function ExecutionModeMenuItems({
  controller,
  disabled,
}: {
  controller: ExecutionModeController;
  disabled: boolean;
}) {
  const { mode, modes, saving, select } = controller;
  if (!modes || modes.length === 0 || !mode) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup
        value={mode}
        onValueChange={select}
        aria-label="执行方式"
      >
        {modes.map((entry) => {
          const ModeIcon = executionModeIcons[entry.id] ?? WorkflowIcon;
          return (
            <DropdownMenuRadioItem
              key={entry.id}
              value={entry.id}
              disabled={disabled || saving}
            >
              <ModeIcon className="size-4 shrink-0" />
              <span>{entry.label}</span>
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </>
  );
}
