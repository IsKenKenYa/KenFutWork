import type { ZCodeProvider } from "@zcode/shared";

export function resolveWorkspaceHeaderProvider(
  activeTaskProvider: ZCodeProvider | null,
  selectedProvider: ZCodeProvider,
): ZCodeProvider {
  // 当前 task 打开时，Header 应展示 task 自己的 provider；
  // 否则在“仅切换新建任务 provider”后会误显示成 workspace 级选择，和当前会话上下文不一致。
  return activeTaskProvider ?? selectedProvider;
}

/**
 * H1（G11）：会话头锁定目录 chip 显示名——取工作目录末段（兼容 Win 反斜杠与
 * POSIX 正斜杠；根路径/空串时回退原串）。Task 主目录身份不可变，chip 只读。
 */
export function resolveLockedDirectoryName(workspacePath: string): string {
  const segments = workspacePath.split(/[\\/]+/u).filter(Boolean);
  return segments.at(-1) ?? workspacePath;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Task 主目录是不是 app 的**沙箱副本**：`<dataDir>/sandbox/<workspaceId>/<taskId>`。
 *
 * 只认「sandbox 段之后恰好两段 uuid」——用户自己的项目目录正好叫 sandbox 时不会被误标；
 * 目录名带四段 uuid 的极端布局也不认（宁可不标，不乱标）。
 */
export function isSandboxWorkspacePath(workspacePath: string): boolean {
  const segments = workspacePath.split(/[\\/]+/u).filter(Boolean);
  const sandboxIndex = segments.lastIndexOf("sandbox");
  if (sandboxIndex < 0 || segments.length - sandboxIndex !== 3) return false;
  return (
    UUID_PATTERN.test(segments[sandboxIndex + 1] ?? "") &&
    UUID_PATTERN.test(segments[sandboxIndex + 2] ?? "")
  );
}
