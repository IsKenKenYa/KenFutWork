import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

/**
 * 桌面形态（FORM-2）的数据目录解析。
 *
 * 桌面 exe 的当前工作目录是「用户双击时所在的目录」——可能是桌面、下载夹、U 盘，
 * 也可能是只读目录，故一切可变状态必须落在**平台惯例的应用数据目录**，不能用
 * `process.cwd()`（现状缺陷：blob 与插件目录都按 cwd 解析）。
 *
 * 解析链：`KENFUTWORK_DATA_DIR` → 系统配置指针 → 平台惯例目录。
 */

export type DesktopPathInput = {
  env: Record<string, string | undefined>;
  /** 注入以便测试；默认 `os.homedir()`。 */
  home?: string;
  /** 注入以便测试；默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  readPointer?: (path: string) => string | null;
};

export const DESKTOP_APP_IDENTIFIER = "com.kenfutwork.desktop";

function isAbsoluteForPlatform(
  path: string,
  platform = process.platform,
): boolean {
  return platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
}

/** 与 Tauri app_data_dir()/data 一致；配置指针是其兄弟文件，不随数据移动。 */
export function resolveDefaultDesktopDataDir(input: DesktopPathInput): string {
  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;

  if (platform === "win32") {
    const base = input.env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    return join(base, DESKTOP_APP_IDENTIFIER, "data");
  }

  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      DESKTOP_APP_IDENTIFIER,
      "data",
    );
  }

  const xdgDataHome = input.env.XDG_DATA_HOME?.trim();
  const base = xdgDataHome || join(home, ".local", "share");
  return join(base, DESKTOP_APP_IDENTIFIER, "data");
}

export function resolveDesktopConfigDir(input: DesktopPathInput): string {
  const explicit = input.env.KENFUTWORK_CONFIG_DIR?.trim();
  if (explicit) {
    if (!isAbsoluteForPlatform(explicit, input.platform)) {
      throw new Error("系统配置目录必须是绝对路径。");
    }
    return explicit;
  }
  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    return join(
      input.env.APPDATA?.trim() || join(home, "AppData", "Roaming"),
      DESKTOP_APP_IDENTIFIER,
    );
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", DESKTOP_APP_IDENTIFIER);
  }
  return join(
    input.env.XDG_CONFIG_HOME?.trim() || join(home, ".config"),
    DESKTOP_APP_IDENTIFIER,
  );
}

export function resolveDataLocationPointerFile(
  input: DesktopPathInput,
): string {
  return join(resolveDesktopConfigDir(input), "data-location.json");
}

export function resolveDesktopDataDir(input: DesktopPathInput): string {
  const explicit = input.env.KENFUTWORK_DATA_DIR?.trim();
  if (explicit) {
    if (!isAbsoluteForPlatform(explicit, input.platform)) {
      throw new Error("应用数据目录必须是绝对路径。");
    }
    return explicit;
  }
  const file = resolveDataLocationPointerFile(input);
  const readPointer =
    input.readPointer ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      }
    });
  const content = readPointer(file);
  if (content === null) return resolveDefaultDesktopDataDir(input);
  const parsed: unknown = JSON.parse(content);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("dataDir" in parsed) ||
    typeof parsed.dataDir !== "string" ||
    !isAbsoluteForPlatform(parsed.dataDir, input.platform)
  ) {
    throw new Error("数据目录配置无效，必须指向绝对路径。");
  }
  return parsed.dataDir;
}

export type DesktopPaths = {
  /** 应用数据目录（用户可见的一切可变状态都在其下）。 */
  dataDir: string;
  /** 本地 blob 根（blob 缝 `local` 形态）。 */
  blobDir: string;
  /** 内嵌 Postgres 集群目录（`PG_VERSION` 存在即已初始化）。 */
  pgDataDir: string;
  /** Postgres 运行日志。 */
  pgLogFile: string;
  /** 内嵌 Postgres 的超级用户口令（首次 initdb 时生成并持久化）。 */
  pgPasswordFile: string;
  /** 本地插件安装目录。 */
  pluginsDir: string;
  checkpointDir: string;
  sandboxDir: string;
  credentialsDir: string;
  /** filesystem 后端的可变文件；归入托管sandbox子树以参与路径重绑定。 */
  agentFilesDir: string;
  /** Code目录索引缓存；由Code索引Provider消费。 */
  indexDir: string;
  /** 应用启动的独立浏览器配置，不影响用户已有浏览器。 */
  browserDir: string;
};

export function resolveDesktopPaths(dataDir: string): DesktopPaths {
  return {
    dataDir,
    blobDir: join(dataDir, "blobs"),
    pgDataDir: join(dataDir, "postgres"),
    pgLogFile: join(dataDir, "logs", "postgres.log"),
    pgPasswordFile: join(dataDir, "postgres-password"),
    pluginsDir: join(dataDir, "plugins"),
    checkpointDir: join(dataDir, "checkpoints"),
    sandboxDir: join(dataDir, "sandbox"),
    credentialsDir: join(dataDir, "credentials"),
    agentFilesDir: join(dataDir, "sandbox", "agent-files"),
    indexDir: join(dataDir, "index"),
    browserDir: join(dataDir, "browser"),
  };
}
