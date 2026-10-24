import {
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@zui/components/ui/context-menu.js";
import { useProjectDirectory } from "@zui/project-sidebar/ProjectDirectoryProvider.js";
import {
  groupTaskRef,
  taskGroupKey,
} from "@zui/project-sidebar/grouped-view.js";
import type { ProjectTask } from "@zui/project-sidebar/contract.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { logger } from "@zui/logger.js";
import { toast } from "@zui/components/ui/toast.js";
export function TaskGroupTaskMenu({ task }: { task: ProjectTask }) {
  const { groups } = useProjectDirectory();
  const { intl } = useZCodeIntl();
  if (!groups.available || task.archived) return null;
  const parent = groups.parents.get(taskGroupKey(task)) ?? null;
  const move = (groupId: string | null) => {
    void groups
      .move(
        { node: { type: "task", task: groupTaskRef(task) }, sourceGroupId: parent, groupId },
        groups.structure.revision,
      )
      .catch((cause) => {
        logger.error("[task-groups] 移动失败", cause);
        toast(intl.formatMessage({ id: "taskGroup.failed" }));
        void groups.refresh();
      });
  };
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="task-group-move-menu">
          {intl.formatMessage({ id: "taskGroup.move" })}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {groups.structure.groups.map((group) => {
            return (
              <ContextMenuItem
                key={group.id}
                disabled={parent === group.id}
                data-task-group-target={group.id}
                onSelect={() => move(group.id)}
              >
                {group.title}
              </ContextMenuItem>
            );
          })}
          {!groups.structure.groups.length ? (
            <ContextMenuItem disabled>
              {intl.formatMessage({ id: "taskGroup.noGroups" })}
            </ContextMenuItem>
          ) : null}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {parent ? (
        <ContextMenuItem data-testid="task-group-remove" onSelect={() => move(null)}>
          {intl.formatMessage({ id: "taskGroup.remove" })}
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
    </>
  );
}
