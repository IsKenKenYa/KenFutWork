import type { ZCodeTaskMeta } from "@zcode/shared";
import { cn } from "@zui/components/lib/utils.js";
import { Button } from "@zui/components/ui/button.js";
import { Input } from "@zui/components/ui/input.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
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

/** 分组色板与服务端 `codeTaskGroupColorSchema` 一一对应。 */
const GROUP_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const;

const GROUP_COLOR_CLASS: Record<(typeof GROUP_COLORS)[number], string> = {
  gray: "bg-neutral-400",
  red: "bg-red-500",
  orange: "bg-orange-500",
  yellow: "bg-yellow-500",
  green: "bg-green-500",
  blue: "bg-sky-500",
  purple: "bg-violet-500",
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
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

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

  /** 改名/换色/删除都要带当前观察修订；服务端以修订做并发保护。 */
  const currentRevision =
    state.status === "ready" ? state.structure.revision : 0;

  const submitRename = useCallback(
    async (groupId: string) => {
      const trimmed = editingTitle.trim();
      if (!trimmed || !port) return;
      setSaving(true);
      try {
        await port.update({
          id: groupId,
          expectedRevision: currentRevision,
          title: trimmed,
        });
        setEditingGroup(null);
        await load();
      } catch {
        // 保留编辑态与输入，用户可改后重试。
      } finally {
        setSaving(false);
      }
    },
    [currentRevision, editingTitle, load, port],
  );

  const submitColor = useCallback(
    async (groupId: string, color: string) => {
      if (!port) return;
      setSaving(true);
      try {
        await port.update({
          id: groupId,
          expectedRevision: currentRevision,
          color,
        });
        await load();
      } finally {
        setSaving(false);
      }
    },
    [currentRevision, load, port],
  );

  const removeGroup = useCallback(
    async (groupId: string) => {
      if (!port) return;
      setSaving(true);
      try {
        await port.remove({ id: groupId, expectedRevision: currentRevision });
        await load();
      } finally {
        setSaving(false);
      }
    },
    [currentRevision, load, port],
  );

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
            <section key={group.id} className="group/row space-y-0.5">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggle(group.id)}
                  aria-expanded={!isCollapsed}
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                >
                  {isCollapsed ? (
                    <ChevronRight className="size-3.5 shrink-0" aria-hidden />
                  ) : (
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                  )}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      GROUP_COLOR_CLASS[group.color],
                    )}
                  />
                  <span className="min-w-0 truncate">{group.title}</span>
                  <span className="ml-auto shrink-0 text-ui-sm">
                    {members.length}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-foreground-subtle opacity-0 hover:text-foreground group-hover/row:opacity-100"
                  aria-label={intl.formatMessage({
                    id: "workspaceSidebar.groupedRename",
                  })}
                  onClick={() => {
                    setEditingGroup(group.id);
                    setEditingTitle(group.title);
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-foreground-subtle opacity-0 hover:text-destructive group-hover/row:opacity-100"
                  aria-label={intl.formatMessage({
                    id: "workspaceSidebar.groupedRemove",
                  })}
                  onClick={() => void removeGroup(group.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              {editingGroup === group.id ? (
                <div className="flex items-center gap-2 pl-6">
                  <Input
                    value={editingTitle}
                    onChange={(event) => setEditingTitle(event.target.value)}
                    aria-label={intl.formatMessage({
                      id: "workspaceSidebar.groupedNamePlaceholder",
                    })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submitRename(group.id);
                      if (event.key === "Escape") setEditingGroup(null);
                    }}
                  />
                  <div className="flex shrink-0 items-center gap-1">
                    {GROUP_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={color}
                        onClick={() => void submitColor(group.id, color)}
                        className={cn(
                          "size-3.5 rounded-full ring-offset-1 hover:ring-1 hover:ring-foreground/30",
                          GROUP_COLOR_CLASS[color],
                          group.color === color && "ring-1 ring-foreground/50",
                        )}
                      />
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void submitRename(group.id)}
                  >
                    {intl.formatMessage({
                      id: "workspaceSidebar.groupedSave",
                    })}
                  </Button>
                </div>
              ) : null}
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
  }, [
    activeTaskId,
    collapsed,
    editingGroup,
    editingTitle,
    intl,
    onSelectTask,
    removeGroup,
    state,
    submitColor,
    submitRename,
    tasks,
    toggle,
  ]);

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
    state.structure.groups.length === 0 && state.structure.members.length === 0
  );
}
