import { canvasFrameRef, useDesignProjectsSnapshot } from "./designProjects.js";

/**
 * Design 主区视图（融合进 Code 壳后的承载面）。
 *
 * 「侧边栏随模式变化」的融合形态：项目列表在**壳侧栏**（HostModeSidebarContent），
 * 这里只承载画布——选中项目即整幅 iframe（含画布页自带的右侧面板）。
 * 不变量沿袭：主区恒为画布，不被对话框顶掉；项目数据与选中态的
 * 真相源在 designProjects.ts（模块级存储，侧栏与主区共享）。
 */
export function HostDesignSurface({ active = true }: { active?: boolean }) {
  const { projects, selectedProjectId, projectsLoaded } =
    useDesignProjectsSnapshot();
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? null;
  // 画布页是 web 应用路由（与 code-ui 同源）；panel=chat 让画布右侧面板
  // （会话/图层/文件）在嵌入态默认打开——iframe 宽度通常低于 1024，
  // 画布页自己的宽度阈值会把面板收起来（用户口径：右边面板要参考原来的）。
  const canvasSrc = selectedProject
    ? `/canvas?id=${encodeURIComponent(selectedProject.primaryCanvas.id)}&panel=chat`
    : null;
  return canvasSrc ? (
    <iframe
      ref={(element) => {
        // 挂到模块引用：壳侧栏的项目增删消息监听只认这只 iframe。
        canvasFrameRef.current = element;
      }}
      src={canvasSrc}
      title={`${selectedProject?.name ?? ""} 画布`}
      inert={!active}
      tabIndex={active ? 0 : -1}
      className="h-full w-full border-0"
    />
  ) : (
    <div
      role="status"
      className="flex h-full items-center justify-center bg-background text-sm text-foreground-subtle"
    >
      {projectsLoaded ? "准备画布…" : "读取画布项目…"}
    </div>
  );
}
