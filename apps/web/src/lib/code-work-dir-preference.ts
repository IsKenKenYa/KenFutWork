/**
 * Code 模式「当前工作目录」的本地记忆。
 *
 * **为什么需要它**：工作目录的选择（`selectedProjectId` + `workDirName`）原本只是组件
 * state，刷新页面就没了。而 Code 模式的 run 作用域取「选中项目的主画布」，没选中时
 * 服务端会懒供给一个隐藏的 code 项目——于是**刷新之后发第一句话，文件悄悄落进
 * `<sandboxRoot>/<canvasId>`，而不是用户配的 `D:\Desktop\test`**，界面上还看不出差别
 * （2026-09-20 真机走查实测：chip 显示「未绑定工作目录」，agent 的落点是 tmp/sandbox/…）。
 *
 * 口径：
 * - 只记**项目 id + 名字**，不记路径——路径的唯一权威是服务端的 `projects.work_dir`
 *   （界面绑定 > env 映射），本地存一份副本只会在目录被改掉之后撒谎；
 * - 恢复时要**对着当前项目列表验一遍**：项目被删了就不能继续选中它；名字仍然记下来，
 *   让既有的「按目录名自动补建项目」那条路继续生效。
 */

export interface CodeWorkDirSelection {
  projectId: string;
  name: string;
}

export const CODE_WORK_DIR_STORAGE_KEY = "workbench:code-work-dir";

/** 可注入的存储（测试里给假实现；浏览器里传 localStorage）。 */
export interface WorkDirStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 记住选择；`null` = 清空（「不在项目中工作」）。存储失败不抛（同其它偏好项口径）。 */
export function saveCodeWorkDir(
  storage: WorkDirStorage | undefined,
  selection: CodeWorkDirSelection | null,
): void {
  if (!storage) return;
  try {
    if (!selection) {
      storage.removeItem(CODE_WORK_DIR_STORAGE_KEY);
      return;
    }
    storage.setItem(
      CODE_WORK_DIR_STORAGE_KEY,
      JSON.stringify({
        projectId: selection.projectId,
        name: selection.name,
      }),
    );
  } catch {
    // 隐私模式 / 配额满：记不住不影响本次使用
  }
}

/** 读回选择（形状不对一律当没存过）。 */
export function loadCodeWorkDir(
  storage: WorkDirStorage | undefined,
): CodeWorkDirSelection | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CODE_WORK_DIR_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { projectId, name } = parsed as Record<string, unknown>;
    if (typeof projectId !== "string" || typeof name !== "string") return null;
    if (!projectId.trim() || !name.trim()) return null;
    return { projectId, name };
  } catch {
    return null;
  }
}

/**
 * 把记忆落到**当前项目列表**上：项目还在就照旧选中；项目没了则保留名字
 * （`startTask` 会按目录名复用/补建项目），但不再给出一个指向空气的 id。
 */
export function reconcileCodeWorkDir(
  saved: CodeWorkDirSelection | null,
  projects: readonly { id: string; name: string }[],
): { projectId: string | null; name: string | null } {
  if (!saved) return { projectId: null, name: null };
  const hit = projects.find((project) => project.id === saved.projectId);
  if (hit) return { projectId: hit.id, name: hit.name };
  // 同名项目还在（id 变了，例如重建过）：跟着它走，别让用户再选一次
  const byName = projects.find((project) => project.name === saved.name);
  if (byName) return { projectId: byName.id, name: byName.name };
  return { projectId: null, name: saved.name };
}
