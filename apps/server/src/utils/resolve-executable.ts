import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * 在 PATH（以及调用方给的常见位置）里找一个可执行文件的**绝对路径**。
 *
 * **为什么不能把裸名交给 `spawn`**：进程可能从一个 PATH 已损坏或陈旧的父进程继承环境。
 * 本机 2026-09-19 就发生过机器级 PATH 被第三方安装器整键覆盖（只剩它自己那一段），
 * `powershell.exe` 按名字根本找不到——桌面端「打开文件夹」当场失败，而终端却照常能用
 * （它的 shell 探测走的就是这条绝对路径）。按绝对路径起进程对这种情况免疫。
 */
export function resolveExecutable(
  names: readonly string[],
  extraPaths: readonly string[] = [],
  env: {
    path?: string | undefined;
    pathExt?: string | undefined;
    platform?: NodeJS.Platform;
  } = {
    path: process.env.PATH,
    pathExt: process.env.PATHEXT,
    platform: process.platform,
  },
): string | null {
  const platform = env.platform ?? process.platform;
  const pathExt =
    platform === "win32" ? (env.pathExt ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = [
    ...(env.path ?? "").split(delimiter).filter(Boolean),
    ...extraPaths,
  ];
  for (const name of names) {
    // 已经带路径分隔符的常量直接验在不在，不再按 PATH 拼
    if (name.includes("/") || name.includes("\\")) {
      if (existsSync(name)) return name;
      continue;
    }
    /**
     * 名字自带扩展名时不能再追加 PATHEXT：`powershell.exe` 会被拼成
     * `powershell.exe.EXE`，那个文件永远不存在，函数返回 null，调用方只能退回
     * 裸命令名交给 `spawn`——PATH 不可靠时这就是「文件夹对话框根本不弹」的
     * 直接原因（实测：本机 powershell.exe 存在、resolveExecutable 却返回 null）。
     */
    const extensions = /\.[A-Za-z0-9]+$/u.test(name) ? [""] : pathExt;
    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = join(dir, `${name}${ext}`);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}
