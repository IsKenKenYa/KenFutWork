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
  initialMode,
}: {
  sessionId: string | null;
  planEnabled?: boolean;
  onSwitchMode?: (mode: string) => void;
  /** 新任务草稿的执行方式；尚无会话时作为本地意图，首个会话创建后写入该会话。 */
  initialMode?: ExecutionMode;
}) {
  const [storedState, setState] = useState(() => emptyState(sessionId));
  const pendingMode = useRef<ExecutionMode | null>(null);
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
    if (!sessionId) {
      if (!initialMode) return;
      // 草稿态没有会话可持久化：只保留本地意图，等首个会话创建后再写入。
      pendingMode.current = initialMode;
      update({ mode: initialMode });
      let alive = true;
      void (async () => {
        try {
          const list = await surfaceJson<{ modes: ModeOption[] }>("/api/execution-modes");
          if (!alive || epoch !== taskGeneration.current || currentSession.current !== sessionId)
            return;
          update({ modes: list.modes });
        } catch {
          // 端点不可用时隐藏菜单；发送仍可使用本地意图。
        }
      })();
      return () => {
        alive = false;
        taskGeneration.current += 1;
      };
    }
    const pending = pendingMode.current;
    pendingMode.current = null;
    let alive = true;
    void (async () => {
      try {
        if (pending) await persist(sessionId, pending).catch(() => {});
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
  }, [initialMode, sessionId, update, persist]);

  const select = useCallback(
    async (next: string) => {
      if (currentSession.current !== sessionId) return;
      const previous = stateRef.current.mode;
      if (stateRef.current.saving || !previous) return;
      const nextMode = next as ExecutionMode;
      const previousPlanning = planning.current ?? previous === "plan";
      const nextPlanning =
        nextMode === "plan" ? true : previous === "plan" ? false : undefined;
      if (!sessionId) {
        // 草稿态切换只改本地意图；首个会话创建时由上面的 effect 统一写入。
        pendingMode.current = nextMode;
        update({ mode: nextMode });
        if (nextPlanning !== undefined)
          switchMode.current?.(nextPlanning ? "plan" : "plan-off");
        return;
      }
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

  // 外部预填（设置页创建技能/插件）在草稿态直接落意图：与手点 chip 不同，
  // 此时 modes 可能还没加载，故同时补一次清单；已有会话仍只走 select。
  const applyDraftMode = useCallback(
    (next: ExecutionMode) => {
      if (currentSession.current !== sessionId || sessionId) return;
      if (stateRef.current.mode === next) return;
      pendingMode.current = next;
      update({ mode: next });
      const epoch = taskGeneration.current;
      void (async () => {
        try {
          const list = await surfaceJson<{ modes: ModeOption[] }>(
            "/api/execution-modes",
          );
          if (epoch !== taskGeneration.current || currentSession.current !== sessionId)
            return;
          update({ modes: list.modes });
        } catch {
          // 端点不可用时隐藏菜单；发送仍使用本地意图。
        }
      })();
    },
    [sessionId, update],
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
      applyDraftMode,
      switchCollaborationMode,
    }),
    [select, applyDraftMode, state.mode, state.modes, state.saving, switchCollaborationMode],
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
