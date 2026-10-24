import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Collapsible } from "@zui/components/ui/collapsible.js";
import { ProjectNodeContent, type ProjectNodeProps } from "@zui/project-sidebar/ProjectNodeContent.js";
import { ProjectTaskListContext } from "@zui/project-sidebar/ProjectTaskListContext.js";
import { projectKey } from "@zui/project-sidebar/view.js";
import { parseWorkbenchProjectTaskDragPayload } from "@zui/v4/workbenchDragDrop.js";

export function ProjectNode(props: ProjectNodeProps) {
  const { project, expanded, onExpandedChange, onMove } = props;
  const { isWebRemoteControl = false } = useContext(ProjectTaskListContext);
  const [sessionDropOver, setSessionDropOver] = useState(false);
  const dragDepth = useRef(0);
  const sessionDropTarget = sessionDropOver;
  useEffect(() => {
    if (!sessionDropTarget) return;
    const clear = () => {
      dragDepth.current = 0;
      setSessionDropOver(false);
    };
    // Escape 或在其他区域松手时，源节点才收到 dragend；目标也要清除临时高亮。
    document.addEventListener("dragend", clear, true);
    document.addEventListener("drop", clear, true);
    return () => {
      document.removeEventListener("dragend", clear, true);
      document.removeEventListener("drop", clear, true);
    };
  }, [sessionDropTarget]);
  const isOpen = expanded;
  const data = useMemo(
    () => ({ hostId: project.hostId, pinned: project.pinned }),
    [project.hostId, project.pinned],
  );
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    active,
    activeIndex,
    index,
    isOver,
  } = useSortable({
    id: projectKey(project),
    // 修复原因：共享项目行曾在手机注册排序手势，滑动列表会误拖；由入口统一禁用。
    disabled: isWebRemoteControl,
    data,
  });
  // 原因：仅有排序位移无法明确落点；直接读取同一拖拽状态，避免提示与提交目标分叉。
  const dropPosition =
    isOver &&
    active &&
    !isDragging &&
    activeIndex >= 0 &&
    active.data.current?.pinned === project.pinned
      ? activeIndex > index
        ? "before"
        : "after"
      : null;
  return (
    <Collapsible asChild open={isOpen} onOpenChange={onExpandedChange}>
      <section
        ref={setNodeRef}
        style={{
          // 原因：项目高度不一致时 dnd-kit 会缩放活动项；只保留排序位移。
          transform: transform
            ? CSS.Transform.toString({ ...transform, scaleX: 1, scaleY: 1 })
            : undefined,
          transition,
          position: "relative",
          zIndex: dropPosition ? 20 : isDragging ? 10 : undefined,
        }}
        data-project-id={project.id}
        data-project-host={project.hostId}
        data-project-name={project.name}
        data-primary-root-status={project.primaryRootStatus}
        className={`min-w-0 rounded-xl ${sessionDropTarget ? "bg-accent" : ""}`}
        onDragEnter={(event) => {
          if (!parseWorkbenchProjectTaskDragPayload(event.dataTransfer)) return;
          dragDepth.current++;
          setSessionDropOver(true);
        }}
        onDragLeave={() => {
          // 子节点切换也会发 enter/leave；只在退出整个项目时移除容器反馈。
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setSessionDropOver(false);
        }}
        onDragOver={(event) => {
          if (parseWorkbenchProjectTaskDragPayload(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(event) => {
          dragDepth.current = 0;
          setSessionDropOver(false);
          event.preventDefault();
          const task = parseWorkbenchProjectTaskDragPayload(event.dataTransfer);
          if (task) onMove(task);
        }}
      >
        {sessionDropTarget && (
          <div
            aria-hidden="true"
            data-testid="project-session-drop-target"
            className="pointer-events-none absolute inset-0 z-10 rounded-xl border-2 border-icon-blue"
          />
        )}
        {dropPosition && (
          <div
            aria-hidden="true"
            data-testid="project-drop-indicator"
            data-drop-position={dropPosition}
            className={`pointer-events-none absolute left-5 right-2 z-20 h-0.5 bg-icon-blue ${dropPosition === "before" ? "top-0 -translate-y-1/2" : "bottom-0 translate-y-1/2"}`}
          >
            <span className="absolute -left-1 top-1/2 size-2 -translate-y-1/2 rounded-full border-2 border-icon-blue bg-sidebar" />
          </div>
        )}
        <ProjectNodeContent
          {...props}
          dragEnabled={!isWebRemoteControl}
          isOpen={isOpen}
          attributes={attributes}
          listeners={listeners}
          setActivatorNodeRef={setActivatorNodeRef}
        />
      </section>
    </Collapsible>
  );
}
