import type { ExecutionMode } from "@kenfutwork/shared";
import { screen } from "@testing-library/react";
import { TooltipProvider } from "@zui/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { V4ComposerModeSwitch } from "@zui/v4/composer/V4ComposerModeControls.js";
import { useEffect, useRef, useState } from "react";
import { vi } from "vitest";
import type { ExecutionModeController } from "../../src/components/workbench/zcode/host/ExecutionModeChip.js";
import { useExecutionModeController } from "../../src/components/workbench/zcode/host/ExecutionModeChip.js";

// 菜单测试不需要设置RPC；实际快捷键仍由原hook读取默认绑定。
vi.mock("@zui/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: null }),
}));

/** 合并菜单的唯一触发器：权限档与执行方式同在这个按钮下。 */
export async function readyComposerModeTrigger() {
  await screen.findByTestId("chat-mode-select-trigger");
  return screen.getByTestId("chat-mode-select-trigger");
}

/**
 * 同一个真实控件：会话设置菜单（权限档 + 执行方式并排同一面板）。
 *
 * `ExecutionModeChip` 只在需要独立入口的旧场景保留；合并后 composer 只渲染
 * `V4ComposerModeSwitch`，两者不再并排出现。
 */
export function ComposerModeMenu({
  controller,
  disabled,
}: {
  controller: ExecutionModeController;
  disabled: boolean;
  planEnabled?: boolean;
  permissionMode?: string;
  onSwitchMode?: (mode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <V4ComposerModeSwitch
          disabled={disabled}
          activeConfigPicker={open ? "mode" : null}
          onConfigPickerOpenChange={(_picker, next) => setOpen(next)}
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
  useEffect(
    () => setPlanning(sessionId ? planEnabled : undefined),
    [planEnabled, sessionId],
  );
  const controller = useExecutionModeController({
    sessionId,
    ...(planning === undefined ? {} : { planEnabled: planning }),
    ...(onSwitchMode ? { onSwitchMode } : {}),
  });
  const notify = useRef(onExecutionModeChange);
  notify.current = onExecutionModeChange;
  useEffect(() => notify.current?.(controller.mode), [controller.mode]);
  return <ComposerModeMenu controller={controller} disabled={disabled} />;
}
