import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_V4_COMPOSER_INPUT,
  type ZCodeConfigOption,
} from "@zcode/shared";
import { ControlHintTooltip } from "@zui/ControlHintTooltip.js";
import { cn } from "@zui/components/lib/utils.js";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import {
  type ExecutionModeController,
  executionModeIcons,
} from "@zui/host/ExecutionModeChip.js";
import {
  PERMISSION_MENU_TIERS,
  type PermissionTier,
  usePermissionTier,
} from "@zui/host/PermissionTierControl.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@zui/lib/pickerFocus.js";
import { useShortcutCommandLabel } from "@zui/shortcuts/useShortcutBindings.js";
import {
  getNextConfigSelectValue,
  useToolbarShortcutBindings,
} from "@zui/v4/composer/toolbarShortcuts.js";
import type { V4ComposerToolbarProps } from "@zui/v4/composer/V4ComposerToolbar.js";
import { ChevronDownIcon, WorkflowIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

function noop(): void {}

/**
 * 会话设置菜单：权限档（变更前确认 / 自动编辑 / 完全访问）与执行方式（自主 / 计划 /
 * 对话 / 目标 / 创造）合并为**一个**下拉，两组并列在同一面板里。
 *
 * 为什么合并：此前工具条上并排三个入口（模式、执行方式、权限），用户要点开其中两个
 * 才知道各自管什么；且旧「模式」菜单列的是 ZCode 上游的 build/edit/plan/yolo，
 * 与本仓库的权限三档同名不同义，最容易看错。现在一个入口、两组选项，各改各的一项。
 */
function V4ComposerModeSwitchImpl({
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  executionModeController,
}: {
  disabled: boolean;
  activeConfigPicker: V4ComposerToolbarProps["activeConfigPicker"];
  onConfigPickerOpenChange: V4ComposerToolbarProps["onConfigPickerOpenChange"];
  /** 执行方式控制器（composer 持有唯一策略状态，菜单只借用它的读与写）。 */
  executionModeController: ExecutionModeController;
}) {
  const { intl } = useZCodeIntl();
  const modeShortcutLabel = useShortcutCommandLabel("cycleSessionMode");
  const { tier, save } = usePermissionTier();
  const [tierSaving, setTierSaving] = useState(false);
  const permissions = PERMISSION_MENU_TIERS;
  const selected = permissions.find((mode) => mode.value === tier);
  const modeOption = useMemo<ZCodeConfigOption>(
    () => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: tier ?? "default",
      options: permissions.map((mode) => ({
        value: mode.value,
        name: mode.label,
      })),
    }),
    [tier],
  );
  const cycle = useCallback(() => {
    const next = getNextConfigSelectValue(modeOption);
    if (next) {
      setTierSaving(true);
      void save(next as PermissionTier).finally(() => setTierSaving(false));
    }
  }, [modeOption, save]);
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(selected),
    toolbarDisabled: disabled,
    modelMenuDisabled: true,
    modeOption,
    onCycleSessionMode: cycle,
    onOpenModelMenu: noop,
    onCycleThoughtLevel: noop,
  });
  if (!selected) return null;
  const {
    mode: executionMode,
    modes,
    select: selectExecutionMode,
  } = executionModeController;
  // 触发器要能同时读到「怎么跑」（执行方式）与「跑之前要不要问」（权限档），
  // 只写权限档时用户看不出当前执行方式，得点开菜单才知道。
  const currentMode = (modes ?? []).find((entry) => entry.id === executionMode);
  const ModeIcon = currentMode
    ? (executionModeIcons[currentMode.id] ?? WorkflowIcon)
    : null;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu
        open={activeConfigPicker === "mode"}
        onOpenChange={(open) => onConfigPickerOpenChange("mode", open)}
      >
        <ControlHintTooltip
          title={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
          shortcut={modeShortcutLabel}
          open={activeConfigPicker === "mode" ? false : undefined}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || tierSaving || !tier}
              data-testid={TID_CHAT_MODE_SELECT_TRIGGER}
              data-composer-collapse-priority="1"
              data-execution-mode={executionMode}
              aria-label={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
              className={cn(
                "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base",
                tier === "full-access" &&
                  "text-warning hover:text-warning aria-expanded:text-warning",
              )}
            >
              <span className="flex min-w-0 items-center gap-1">
                {ModeIcon && currentMode ? (
                  <>
                    <ModeIcon className="size-3.5 shrink-0" />
                    <span>{currentMode.label}</span>
                    <span>·</span>
                  </>
                ) : null}
                <span className="min-w-0 truncate">{selected.label}</span>
              </span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-foreground-subtle" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-64"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!isCoarseTouchDevice())
              document
                .querySelector<HTMLElement>(
                  `[data-testid="${TID_V4_COMPOSER_INPUT}"]`,
                )
                ?.focus();
          }}
        >
          {/* 两个小标题各带一个下拉框（用户口径 2026-11-22）：没有选项说明，
              也没有勾选式单选列表。左右布局改为上下两行，标签在左、控件在右。 */}
          <div className="space-y-2 p-2">
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-ui-base font-medium text-foreground">
                执行方式
              </span>
              <Select
                value={executionMode ?? ""}
                onValueChange={(next) => void selectExecutionMode(next)}
                disabled={disabled}
              >
                <SelectTrigger size="lg" aria-label="执行方式" className="w-40">
                  <SelectValue placeholder="读取中" />
                </SelectTrigger>
                <SelectContent>
                  {(modes ?? []).map((mode) => (
                    <SelectItem key={mode.id} value={mode.id}>
                      {mode.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="h-px w-full bg-border" aria-hidden="true" />
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-ui-base font-medium text-foreground">
                权限
              </span>
              <Select
                value={tier ?? ""}
                onValueChange={(next) => {
                  setTierSaving(true);
                  void save(next as PermissionTier).finally(() =>
                    setTierSaving(false),
                  );
                }}
                disabled={disabled || tierSaving}
              >
                <SelectTrigger size="lg" aria-label="权限" className="w-40">
                  <SelectValue placeholder="读取中" />
                </SelectTrigger>
                <SelectContent>
                  {permissions.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
