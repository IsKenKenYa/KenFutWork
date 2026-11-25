import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { cn } from "@zui/components/lib/utils.js";
import { Button } from "@zui/components/ui/button.js";
import { Input } from "@zui/components/ui/input.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  GripVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTaskGroupPort } from "./TaskGroupPort.js";
import {
  groupMembersInOrder,
  groupsInOrder,
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

  // 与侧栏项目分区同一套传感器：8px 位移才起拖，避免误触；键盘可排序。
  const groupSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

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

  /**
   * 分组重排：分组只能在根层移动，用目标分组作锚点。
   * 拖到目标之前还是之后，由两个分组在根层顺序里的相对位置决定。
   */
  const moveGroupTo = useCallback(
    async (activeGroupId: string, overGroupId: string) => {
      if (!port || state.status !== "ready" || activeGroupId === overGroupId)
        return;
      const ordered = groupsInOrder(state.structure);
      const fromIndex = ordered.findIndex((g) => g.id === activeGroupId);
      const toIndex = ordered.findIndex((g) => g.id === overGroupId);
      if (fromIndex < 0 || toIndex < 0) return;
      // 向下拖 = 落到目标之后；向上拖 = 落到目标之前。
      const side: "before" | "after" = fromIndex < toIndex ? "after" : "before";
      setSaving(true);
      try {
        await port.move({
          node: { type: "group", groupId: activeGroupId },
          sourceGroupId: null,
          groupId: null,
          expectedRevision: currentRevision,
          anchor: { node: { type: "group", groupId: overGroupId }, side },
        });
        await load();
      } finally {
        setSaving(false);
      }
    },
    [currentRevision, load, port, state],
  );

  const handleGroupDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      void moveGroupTo(String(active.id), String(over.id));
    },
    [moveGroupTo],
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
    const orderedGroups = groupsInOrder(structure);
    return (
      <>
        <DndContext
          sensors={groupSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleGroupDragEnd}
        >
          <SortableContext
            items={orderedGroups.map((group) => group.id)}
            strategy={verticalListSortingStrategy}
          >
            {orderedGroups.map((group) => (
              <SortableGroupRow
                key={group.id}
                groupId={group.id}
                dragHandleLabel={intl.formatMessage({
                  id: "workspaceSidebar.groupedReorder",
                })}
              >
                <GroupRowBody
                  group={group}
                  members={groupMembersInOrder(structure, group.id)}
                  isCollapsed={collapsed.has(group.id)}
                  activeTaskId={activeTaskId}
                  editing={editingGroup === group.id}
                  editingTitle={editingTitle}
                  intl={intl}
                  onToggle={() => toggle(group.id)}
                  onBeginRename={() => {
                    setEditingGroup(group.id);
                    setEditingTitle(group.title);
                  }}
                  onEditingTitleChange={setEditingTitle}
                  onCancelRename={() => setEditingGroup(null)}
                  onCommitRename={() => void submitRename(group.id)}
                  onPickColor={(color) => void submitColor(group.id, color)}
                  onRemove={() => void removeGroup(group.id)}
                  onSelectTask={onSelectTask}
                />
              </SortableGroupRow>
            ))}
          </SortableContext>
        </DndContext>
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
    groupSensors,
    handleGroupDragEnd,
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

/**
 * 可拖拽的分组行：拖拽抓手独立于折叠按钮，避免点标题时误拖。
 * 位移与过渡交给 dnd-kit，拖拽中稍微降低不透明度提示「正在搬」。
 */
function SortableGroupRow({
  groupId,
  dragHandleLabel,
  children,
}: {
  groupId: string;
  dragHandleLabel: string;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: groupId });
  const style: CSSProperties = {
    transform: transform
      ? CSS.Transform.toString({ ...transform, scaleX: 1, scaleY: 1 })
      : undefined,
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };
  return (
    <section ref={setNodeRef} style={style} className="group/row space-y-0.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={dragHandleLabel}
          className="shrink-0 cursor-grab rounded-md p-1 text-foreground-subtlest opacity-0 hover:text-foreground active:cursor-grabbing group-hover/row:opacity-100"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
      </div>
    </section>
  );
}

/** 分组行主体：折叠标题、改名/换色/删除按钮，以及展开后的成员列表。 */
function GroupRowBody({
  group,
  members,
  isCollapsed,
  activeTaskId,
  editing,
  editingTitle,
  intl,
  onToggle,
  onBeginRename,
  onEditingTitleChange,
  onCancelRename,
  onCommitRename,
  onPickColor,
  onRemove,
  onSelectTask,
}: {
  group: { id: string; title: string; color: (typeof GROUP_COLORS)[number] };
  members: readonly ZCodeTaskMeta[];
  isCollapsed: boolean;
  activeTaskId?: string | null | undefined;
  editing: boolean;
  editingTitle: string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onToggle: () => void;
  onBeginRename: () => void;
  onEditingTitleChange: (value: string) => void;
  onCancelRename: () => void;
  onCommitRename: () => void;
  onPickColor: (color: string) => void;
  onRemove: () => void;
  onSelectTask: (task: ZCodeTaskMeta) => void;
}) {
  return (
    <>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
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
          <span className="ml-auto shrink-0 text-ui-sm">{members.length}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-foreground-subtle opacity-0 hover:text-foreground group-hover/row:opacity-100"
          aria-label={intl.formatMessage({
            id: "workspaceSidebar.groupedRename",
          })}
          onClick={onBeginRename}
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
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {editing ? (
        <div className="flex items-center gap-2 pl-6">
          <Input
            value={editingTitle}
            onChange={(event) => onEditingTitleChange(event.target.value)}
            aria-label={intl.formatMessage({
              id: "workspaceSidebar.groupedNamePlaceholder",
            })}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommitRename();
              if (event.key === "Escape") onCancelRename();
            }}
          />
          <div className="flex shrink-0 items-center gap-1">
            {GROUP_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                onClick={() => onPickColor(color)}
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
            onClick={onCommitRename}
          >
            {intl.formatMessage({ id: "workspaceSidebar.groupedSave" })}
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
    </>
  );
}

function structureIsEmpty(state: Extract<GroupViewState, { status: "ready" }>) {
  return (
    state.structure.groups.length === 0 && state.structure.members.length === 0
  );
}
