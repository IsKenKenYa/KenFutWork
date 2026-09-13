/**
 * 工作台主区「该显示什么」的唯一判定（Design 模式不变量）。
 *
 * **为什么单独抽出来**：这段判断原先内联在 workbench.tsx 的 JSX 分支里，顺序是
 * `activeTask → design+项目 → 编排器`。于是 Design 模式一旦有「任务/会话」被激活，
 * 主区就变成对话框、画布被顶掉——用户已多次反馈「Design 模式又变成对话框了」。
 * 抽成纯函数后：判定只有一处、可被测试锁死，顺序回归会立刻红灯。
 *
 * **不变量**：Design 模式选中项目后，主区**永远**是画布；对话框不得取代它
 * （设计模式的对话入口在画布页自己的助手面板里）。
 */

export type WorkbenchMode = "code" | "design";

export type WorkbenchSurface =
  /** 画布（设计模式的主界面）。 */
  | "canvas"
  /** 任务/会话对话框（仅 Code 模式）。 */
  | "conversation"
  /** 居中编排器（首页输入框；Design 模式仅在还没有项目时短暂出现）。 */
  | "orchestrator";

export function resolveWorkbenchSurface(input: {
  mode: WorkbenchMode;
  /** 设计模式是否已选中项目（选中即应开画布）。 */
  hasSelectedProject: boolean;
  /** 是否存在激活的任务/会话（Code 模式的任务视图）。 */
  hasActiveTask: boolean;
}): WorkbenchSurface {
  if (input.mode === "design") {
    // 画布优先：设计模式不存在「对话框顶掉画布」的分支
    return input.hasSelectedProject ? "canvas" : "orchestrator";
  }

  return input.hasActiveTask ? "conversation" : "orchestrator";
}
