import { Blocks, CalendarClock } from "lucide-react";
import { TID_AUTOMATIONS_OPEN } from "@zcode/shared";
import type { ProjectSidebarProps } from "@zui/project-sidebar/contract.js";
import { Button } from "@zui/components/ui/button.js";
import { NewTaskButtonGroup } from "@zui/NewTaskButtonGroup.js";
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
  >;
  onCreate(): void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
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
    </div>
  );
}
