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
  "当前环境不支持目录选择器（需要 Chromium 内核或桌面端，且页面未被 iframe 策略禁用）。";

/**
 * 从填写的绝对路径里取目录名（作为项目名）。
 * 两端分隔符都认（`D:\Desktop\test` 与 `/home/me/app`），末尾分隔符忽略；
 * 取不出来（如 `D:\` 或 `/`）时返回空串，由调用方决定提示。
 */
export function workDirNameFromPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  // 盘符根（`D:`）与 POSIX 根（已在上一步变空）都不算目录名
  if (/^[a-zA-Z]:$/.test(trimmed)) return "";
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] ?? "";
}

/**
 * 「打开文件夹」这一项的副标题：说清这次会开哪种选择器、选完会发生什么。
 *
 * 两种形态差别很大，不写清就只能靠猜：
 * - 桌面形态：服务端弹**系统对话框**，拿回绝对路径 → 直接绑成 `projects.work_dir`（真绑定）；
 * - 其它形态：浏览器选择器只给得到目录名 → 按目录名复用/新建同名项目。
 */
export function folderPickerHint(
  native: { available: boolean } | null | undefined,
): string {
  if (native?.available) {
    return "系统文件夹对话框 · 路径直接绑成工作目录";
  }
  return "浏览器选择器 · 按目录名复用或新建";
}

/**
 * 拼进 prompt 的工作目录说明（**已绑定真实目录**时用这一份）。
 *
 * 与只拿到目录名的 {@link workDirectoryPromptHint} 的区别：这次本机绝对路径是真的——
 * 服务端把 `projects.work_dir` 解析成了工作区根目录，文件确实落在用户填的那个目录里。
 * 所以这里可以说出真实路径，但**仍然要求相对工作区根写路径**：绝对路径会让模型把
 * 路径当字符串拼接（实测套出一层同名目录），而且工作区之外的绝对路径会被沙箱边界拒。
 */
export function boundWorkDirPromptHint(path: string): string {
  return (
    `【工作目录：${path}（用户已绑定的本机真实目录，就是本轮工作区的**根目录**）——` +
    `所有文件路径**相对工作区根书写**（如 \`main.py\`、\`src/app.ts\`），` +
    `**不要**写绝对路径、也不要在工作区下再建一层同名目录；` +
    `工作区之外的路径（\`/tmp/…\`、其它盘符目录）会被沙箱边界拒绝】`
  );
}

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
    notice: `选择工作目录失败：${message}`,
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
 *
 * 还必须点明「工作区根目录就是它」：只给名字时，真实模型会把这个名字当成工作区下的
 * **子目录**，把项目写进 `<names>/项目名/`（实测两次：GLM-5.3-Flash 把 kfw-py-demo
 * 建到了 `test/kfw-py-demo/`，用户看到文件"没落在工作目录里"）。所以这里明确要求
 * 相对工作区根写路径、不要再套一层同名目录。
 */
export function workDirectoryPromptHint(name: string): string {
  return (
    `【工作目录：${name}（用户选择的目录名，仅作标识）——沙箱工作区的**根目录就是它**，` +
    `不要在工作区下再建一个叫「${name}」的子目录；所有文件路径**必须相对工作区根书写**` +
    `（如 \`kfw-demo/main.py\`），**禁止任何绝对路径**（\`/tmp/…\`、\`/test/…\`、\`D:…\` 都不行：` +
    `它们在真实机器上不存在，会落到工作区里多出一层同名目录）；` +
    `本机真实路径对服务端不可达，所以也不要 chdir 到工作目录之外。实际落点以工具返回为准】`
  );
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
