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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
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
              {/* 触发器只写当前权限档，不再带图标（用户口径：最左边这个手去掉）。 */}
              <span>{selected.label}</span>
              <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
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
          <DropdownMenuRadioGroup
            value={tier ?? ""}
            onValueChange={(next) => {
              setTierSaving(true);
              void save(next as PermissionTier).finally(() =>
                setTierSaving(false),
              );
            }}
            aria-label="权限"
          >
            {permissions.map((entry) => (
              <DropdownMenuRadioItem
                key={entry.value}
                value={entry.value}
                disabled={disabled || tierSaving}
                className="min-h-13 items-start gap-3 py-2"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{entry.label}</span>
                  <span className="text-ui-sm text-foreground-subtle">
                    {entry.hint}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          {/* 执行方式与权限档**并列**在同一面板：两者都决定这次提交怎么跑，
              分两个入口时用户要先点开才知道区别。 */}
          <DropdownMenuRadioGroup
            value={executionMode ?? ""}
            onValueChange={(next) => void selectExecutionMode(next)}
            aria-label="执行方式"
          >
            {(modes ?? []).map((mode) => {
              const ModeIcon = executionModeIcons[mode.id] ?? WorkflowIcon;
              return (
                <DropdownMenuRadioItem
                  key={mode.id}
                  value={mode.id}
                  disabled={disabled}
                >
                  <ModeIcon className="size-4 shrink-0" />
                  <span>{mode.label}</span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
