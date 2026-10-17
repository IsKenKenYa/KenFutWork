import type { ExecutionMode } from "@kenfutwork/shared";
import { screen } from "@testing-library/react";
import { TooltipProvider } from "@zui/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { V4ComposerModeSwitch } from "@zui/v4/composer/V4ComposerModeControls.js";
import { useEffect, useRef, useState } from "react";
import { vi } from "vitest";
import {
  type ExecutionModeController,
  useExecutionModeController,
} from "../../src/components/workbench/zcode/host/ExecutionModeChip.js";

// 菜单测试不需要设置RPC；实际快捷键仍由原hook读取默认绑定。
vi.mock("@zui/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: null }),
}));

export async function readyComposerModeTrigger() {
  await screen.findByTestId("execution-mode-label");
  return screen.getByTestId("chat-mode-select-trigger");
}

/** 同一个真实盾牌菜单；只提供Renderer依赖和受控草稿，不复制菜单或策略实现。 */
export function ComposerModeMenu({
  controller,
  disabled,
  planEnabled,
  permissionMode = "yolo",
  onSwitchMode,
}: {
  controller: ExecutionModeController;
  disabled: boolean;
  planEnabled: boolean;
  permissionMode?: string;
  onSwitchMode: (mode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <V4ComposerModeSwitch
          workspacePath="/workspace"
          draftConfig={{ mode: permissionMode, planEnabled }}
          disabled={disabled}
          activeConfigPicker={open ? "mode" : null}
          onConfigPickerOpenChange={(_picker, next) => setOpen(next)}
          onSwitchMode={onSwitchMode}
          executionModeController={controller}
        />
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

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
  const [planning, setPlanning] = useState(planEnabled);
  const [permissionMode, setPermissionMode] = useState("yolo");
  useEffect(
    () => setPlanning(sessionId ? planEnabled : undefined),
    [planEnabled, sessionId],
  );
  const controller = useExecutionModeController({
    sessionId,
    ...(planning === undefined ? {} : { planEnabled: planning }),
    onSwitchMode: (next) => {
      if (next === "plan" || next === "plan-off") setPlanning(next === "plan");
      else setPermissionMode(next);
      onSwitchMode?.(next);
    },
  });
  const notify = useRef(onExecutionModeChange);
  notify.current = onExecutionModeChange;
  useEffect(() => notify.current?.(controller.mode), [controller.mode]);
  return (
    <ComposerModeMenu
      controller={controller}
      disabled={disabled}
      planEnabled={planning ?? controller.mode === "plan"}
      permissionMode={permissionMode}
      onSwitchMode={controller.switchCollaborationMode}
    />
  );
}
