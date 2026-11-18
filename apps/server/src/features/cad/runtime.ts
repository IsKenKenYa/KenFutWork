import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface CadRuntime {
  executable: string;
  runtimeRoot: string;
}

/** 只发现已安装运行时；版本由实际执行回执提供，不启动宿主探针进程。 */
export async function detectFreeCadRuntime(options?: {
  executable?: string;
  platform?: NodeJS.Platform;
  path?: string;
}): Promise<CadRuntime | null> {
  const platform = options?.platform ?? process.platform;
  const candidates = options?.executable
    ? [options.executable]
    : platform === "darwin"
      ? [
          "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd",
          "/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd",
        ]
      : platform === "win32"
        ? [
            join(
              process.env.ProgramFiles ?? "C:\\Program Files",
              "FreeCAD 1.1",
              "bin",
              "FreeCADCmd.exe",
            ),
            join(
              process.env.ProgramFiles ?? "C:\\Program Files",
              "FreeCAD 1.0",
              "bin",
              "FreeCADCmd.exe",
            ),
          ]
        : [
            "/usr/bin/FreeCADCmd",
            "/usr/bin/freecadcmd",
            "/usr/local/bin/freecadcmd",
          ];
  if (!options?.executable) {
    for (const entry of (options?.path ?? process.env.PATH ?? "").split(
      platform === "win32" ? ";" : ":",
    )) {
      if (entry && isAbsolute(entry)) {
        candidates.push(
          join(entry, platform === "win32" ? "FreeCADCmd.exe" : "freecadcmd"),
        );
      }
    }
  }
  for (const candidate of candidates) {
    try {
      if (!isAbsolute(candidate)) continue;
      const executable = await realpath(candidate);
      if (!(await stat(executable)).isFile()) continue;
      await access(
        executable,
        platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      const bundle = executable.match(/^(.*\/[^/]+\.app)\//u)?.[1];
      return {
        executable,
        runtimeRoot:
          bundle ??
          (basename(dirname(executable)) === "bin"
            ? resolve(dirname(executable), "..")
            : dirname(executable)),
      };
    } catch (error) {
      if (options?.executable) throw error;
    }
  }
  return null;
}
