import type { ExecutionMode } from "@kenfutwork/shared";
import { useEffect, useRef } from "react";
import {
  ExecutionModeChip,
  useExecutionModeController,
} from "../../src/components/workbench/zcode/host/ExecutionModeChip.js";

/** 旧菜单测试同样由真实Composer策略owner驱动，不替换其状态或网络行为。 */
export function ExecutionModeChipProbe({
  sessionId,
  disabled,
  planEnabled,
  onSwitchMode,
  onExecutionModeChange,
}: {
  sessionId: string | null;
  disabled: boolean;
  planEnabled?: boolean;
  onSwitchMode?: (mode: string) => void;
  onExecutionModeChange?: (mode: ExecutionMode | undefined) => void;
}) {
  const controller = useExecutionModeController({
    sessionId,
    ...(planEnabled === undefined ? {} : { planEnabled }),
    ...(onSwitchMode ? { onSwitchMode } : {}),
  });
  const notify = useRef(onExecutionModeChange);
  notify.current = onExecutionModeChange;
  useEffect(() => notify.current?.(controller.mode), [controller.mode]);
  return <ExecutionModeChip controller={controller} disabled={disabled} />;
}
