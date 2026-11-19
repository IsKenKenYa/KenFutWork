import type { ZCodeTaskMeta } from "@zcode/shared";
import { Button } from "@zui/components/ui/button.js";
import { Input } from "@zui/components/ui/input.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { ChevronDown, ChevronRight, FolderPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTaskGroupPort } from "./TaskGroupPort.js";
import {
  groupMembersInOrder,
  parseTaskGroupStructure,
  rootTasksInOrder,
  toGroupedTaskViewStructure,
} from "./taskGroupStructure.js";

type GroupViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      structure: ReturnType<typeof toGroupedTaskViewStructure>;
    };

/**
 * 侧栏「分组」页签：按服务端 `task-groups` 的组织结构渲染分组与根层任务。
 *
 * 服务端只保存组织本身（分组、成员、根层顺序），任务正文来自任务列表；
 * 因此这里只按成员引用取任务行，取不到的成员（已归档/删除）直接跳过，不造占位。
 * 组织变化通过 `state:task-groups` 事件通知，收到后重读一次。
 */
export function WorkspaceGroupedTasksSection({
  tasks,
  activeTaskId,
  onSelectTask,
  onCreateGroup,
}: {
  tasks: readonly ZCodeTaskMeta[];
  activeTaskId?: string | null;
  onSelectTask: (task: ZCodeTaskMeta) => void;
  onCreateGroup?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const port = useTaskGroupPort();
  const [state, setState] = useState<GroupViewState>({ status: "loading" });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!port) {
      setState({
        status: "error",
        message: intl.formatMessage({
          id: "workspaceSidebar.groupedUnavailable",
        }),
      });
      return;
    }
    try {
      const structure = parseTaskGroupStructure(await port.read());
      setState({
        status: "ready",
        structure: toGroupedTaskViewStructure(structure, tasks),
      });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error ? error.message : "分组读取失败，请重试。",
      });
    }
  }, [intl, port, tasks]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback((groupId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const submitGroup = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || saving || !port) return;
    setSaving(true);
    try {
      await port.create({
        title: trimmed,
        expectedRevision:
          state.status === "ready" ? state.structure.revision : 0,
      });
      setTitle("");
      setCreating(false);
      onCreateGroup?.();
      await load();
    } catch {
      // 失败保留输入框内容，用户可改名后重试。
    } finally {
      setSaving(false);
    }
  }, [load, onCreateGroup, port, saving, state, title]);

  const rendered = useMemo(() => {
    if (state.status !== "ready") return null;
    const { structure } = state;
    const rootTasks = rootTasksInOrder(structure, tasks);
    return (
      <>
        {structure.groups.map((group) => {
          const members = groupMembersInOrder(structure, group.id);
          const isCollapsed = collapsed.has(group.id);
          return (
            <section key={group.id} className="space-y-0.5">
              <button
                type="button"
                onClick={() => toggle(group.id)}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 truncate">{group.title}</span>
                <span className="ml-auto shrink-0 text-ui-sm">
                  {members.length}
                </span>
              </button>
              {isCollapsed
                ? null
                : members.map((task) => (
                    <button
                      key={task.taskId}
                      type="button"
                      data-active={task.taskId === activeTaskId}
                      onClick={() => onSelectTask(task)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-2 pl-6 text-left text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground data-[active=true]:bg-selected data-[active=true]:text-foreground"
                    >
                      <span className="min-w-0 truncate">{task.title}</span>
                    </button>
                  ))}
            </section>
          );
        })}
        {rootTasks.length > 0 ? (
          <section className="space-y-0.5">
            <div className="px-2 py-1 text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "workspaceSidebar.groupedUngrouped" })}
            </div>
            {rootTasks.map((task) => (
              <button
                key={task.taskId}
                type="button"
                data-active={task.taskId === activeTaskId}
                onClick={() => onSelectTask(task)}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground data-[active=true]:bg-selected data-[active=true]:text-foreground"
              >
                <span className="min-w-0 truncate">{task.title}</span>
              </button>
            ))}
          </section>
        ) : null}
      </>
    );
  }, [activeTaskId, collapsed, intl, onSelectTask, state, tasks, toggle]);

  return (
    <div className="flex min-h-0 flex-col gap-2 px-2">
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "workspaceSidebar.groupedTitle" })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-foreground-subtle hover:text-foreground"
          aria-label={intl.formatMessage({
            id: "workspaceSidebar.groupedNewGroup",
          })}
          onClick={() => setCreating((open) => !open)}
        >
          <FolderPlus className="size-3.5" />
        </Button>
      </div>
      {creating ? (
        <form
          className="flex items-center gap-2 px-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitGroup();
          }}
        >
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={intl.formatMessage({
              id: "workspaceSidebar.groupedNamePlaceholder",
            })}
            aria-label={intl.formatMessage({
              id: "workspaceSidebar.groupedNamePlaceholder",
            })}
            autoFocus
          />
          <Button type="submit" variant="outline" size="sm" disabled={saving}>
            {intl.formatMessage({ id: "workspaceSidebar.groupedCreate" })}
          </Button>
        </form>
      ) : null}
      {state.status === "loading" ? (
        <div className="px-2 py-2 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "workspaceSidebar.groupedLoading" })}
        </div>
      ) : state.status === "error" ? (
        <div className="px-2 py-2 text-ui-base text-destructive">
          {state.message}
        </div>
      ) : structureIsEmpty(state) ? (
        <div className="px-2 py-2 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "workspaceSidebar.groupedEmpty" })}
        </div>
      ) : (
        rendered
      )}
    </div>
  );
}

function structureIsEmpty(state: Extract<GroupViewState, { status: "ready" }>) {
  return (
    state.structure.groups.length === 0 &&
    state.structure.members.length === 0
  );
}
