/**
 * 工作目录选择（Code 模式输入区）。
 *
 * 修正的两个问题（GUI/代码核查发现）：
 * 1. **静默失败**：`showDirectoryPicker` 不可用（非 Chromium 内核、iframe 内被策略
 *    禁用）时直接 return，用户点了按钮没有任何反馈；出错也被空 catch 吞掉。
 * 2. **误导模型**：选中的只有**文件夹名**（浏览器侧的 FileSystemDirectoryHandle
 *    无法传给服务端），但过去把它当「工作目录」拼进 prompt，模型会以为本机路径
 *    可达——实测模型据此用过时的虚拟绝对路径写文件，落到嵌套子目录。
 *
 * 因此这里把「反馈」和「提示文案」都做成纯函数，便于单测；真正的「把本机文件夹
 * 绑定为智能体工作目录」需要产品决策（见改造计划登记项），不在本文件假装实现。
 */

/** 浏览器目录选择器的最小形状（`window.showDirectoryPicker`）。 */
export type DirectoryPicker = () => Promise<{ name: string }>;

export type WorkDirectoryPickResult =
  | { status: "picked"; name: string }
  | { status: "unsupported"; notice: string }
  | { status: "cancelled" }
  | { status: "failed"; notice: string };

export const UNSUPPORTED_DIRECTORY_PICKER_NOTICE =
  "当前环境不支持选择文件夹（需要 Chromium 内核，且页面未被 iframe 策略禁用）。智能体在沙箱工作区中执行，本机文件夹暂不能直接绑定。";

/** 从 window 形态对象里取目录选择器；缺失返回 undefined。 */
export function resolveDirectoryPicker(
  win: unknown,
): DirectoryPicker | undefined {
  if (!win || typeof win !== "object") {
    return undefined;
  }
  const picker = (win as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  return typeof picker === "function" ? (picker as DirectoryPicker) : undefined;
}

/**
 * 把选择器的失败转成面向用户的说明。
 * 用户主动取消（AbortError）返回 cancelled——取消是正常操作，不该弹提示。
 */
export function describePickFailure(error: unknown): WorkDirectoryPickResult {
  const name =
    typeof error === "object" && error !== null
      ? (error as { name?: unknown }).name
      : undefined;
  if (name === "AbortError") {
    return { status: "cancelled" };
  }
  const message =
    error instanceof Error ? error.message : String(error ?? "未知错误");
  return {
    status: "failed",
    notice: `选择文件夹失败：${message}`,
  };
}

/**
 * 执行一次选择，返回可判定结果（不触碰 React 状态）。
 */
export async function pickWorkDirectory(
  win: unknown,
): Promise<WorkDirectoryPickResult> {
  const picker = resolveDirectoryPicker(win);
  if (!picker) {
    return {
      status: "unsupported",
      notice: UNSUPPORTED_DIRECTORY_PICKER_NOTICE,
    };
  }
  try {
    const dir = await picker();
    const name = typeof dir?.name === "string" ? dir.name.trim() : "";
    if (!name) {
      return { status: "cancelled" };
    }
    return { status: "picked", name };
  } catch (error) {
    return describePickFailure(error);
  }
}

/**
 * 拼进 prompt 的工作目录说明。
 *
 * 措辞必须诚实：只有目录**名称**来自浏览器，服务端拿不到本机路径，
 * 实际读写发生在沙箱工作区——写明这一点，模型才不会按本机绝对路径去操作。
 */
export function workDirectoryPromptHint(name: string): string {
  return `【目录名称：${name}（仅用户标注的命名提示；本机路径对服务端不可达，读写发生在沙箱工作区，路径以工具返回为准）】`;
}

/**
 * Code 模式「工作目录 = 项目」：选定目录名后应落到哪个项目。
 *
 * 为什么必须有这一步：生产后端要求每轮 run 绑定项目（`canvasId is required for
 * production (state) backend mode`），不绑定就整轮失败；而浏览器只给得到目录名。
 * 所以选定目录后按目录名找同名项目复用，没有才新建——run 以项目主画布为作用域，
 * 同一项目的多轮运行共享同一个沙箱工作目录。
 */
export type WorkDirProjectPlan =
  | { kind: "reuse"; projectId: string }
  | { kind: "create"; name: string };

export function resolveWorkDirProject(
  pickedName: string,
  projects: ReadonlyArray<{ id: string; name: string }>,
): WorkDirProjectPlan {
  const name = pickedName.trim();
  if (!name) {
    return { kind: "create", name };
  }
  const existing = projects.find((project) => project.name === name);
  return existing
    ? { kind: "reuse", projectId: existing.id }
    : { kind: "create", name };
}
