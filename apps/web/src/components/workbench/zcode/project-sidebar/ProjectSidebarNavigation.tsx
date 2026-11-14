import { Blocks, CalendarClock, Cpu } from "lucide-react";
import { useSyncExternalStore } from "react";
import { TID_AUTOMATIONS_OPEN } from "@zcode/shared";
import type { ProjectSidebarProps } from "@zui/project-sidebar/contract.js";
import { Button } from "@zui/components/ui/button.js";
import { NewTaskButtonGroup } from "@zui/NewTaskButtonGroup.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";

/** 顶部导航只展示 Shell 的选中状态，路由仍由 Shell 唯一持有。 */
export function ProjectSidebarNavigation({
  props,
  onCreate,
  disabled = false,
}: {
  props: Pick<
    ProjectSidebarProps,
    | "onOpenAutomations"
    | "automationsActive"
    | "onOpenPluginStore"
    | "pluginStoreActive"
    | "onOpenWorkEngine"
    | "workEngineActive"
  >;
  onCreate(): void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const workbenchNavigation = useOptionalPlatform()?.workbenchNavigation;
  const workbenchMode = useSyncExternalStore(
    workbenchNavigation?.subscribe ?? (() => () => {}),
    () => workbenchNavigation?.getSnapshot().mode ?? "code",
  );
  return (
    <div
      data-testid="sidebar-primary-navigation"
      className="flex flex-col gap-1 px-2 py-3"
    >
      <NewTaskButtonGroup onCreateTask={onCreate} disabled={disabled} />
      {props.onOpenAutomations ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.automationsActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.automationsActive ?? false}
          data-testid={TID_AUTOMATIONS_OPEN}
          // 点击事件不能进入业务导航的可选 automationId 参数。
          onClick={() => props.onOpenAutomations?.()}
        >
          <CalendarClock className="size-4" />
          {intl.formatMessage({ id: "workspace.openScheduledSettings" })}
        </Button>
      ) : null}
      {props.onOpenPluginStore ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.pluginStoreActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.pluginStoreActive ?? false}
          data-testid="plugin-store-sidebar-open"
          onClick={() => props.onOpenPluginStore?.()}
        >
          <Blocks className="size-4" />
          {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
        </Button>
      ) : null}
      {/* Work 引擎入口只在 Work 模式出现（用户 2026-10-27 口径）：其它模式没有引擎页，不摆空入口。 */}
      {workbenchMode === "work" && props.onOpenWorkEngine ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.workEngineActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.workEngineActive ?? false}
          data-testid="work-engine-sidebar-open"
          onClick={() => props.onOpenWorkEngine?.()}
        >
          <Cpu className="size-4" />
          Work 引擎
        </Button>
      ) : null}
    </div>
  );
}
