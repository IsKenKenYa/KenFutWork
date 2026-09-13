import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 桌面形态（FORM-2）的数据目录解析。
 *
 * 桌面 exe 的当前工作目录是「用户双击时所在的目录」——可能是桌面、下载夹、U 盘，
 * 也可能是只读目录，故一切可变状态必须落在**平台惯例的应用数据目录**，不能用
 * `process.cwd()`（现状缺陷：blob 与插件目录都按 cwd 解析）。
 *
 * 解析链：`LOOMIC_DATA_DIR`（显式覆盖，测试与自托管用）→ 平台惯例目录。
 */

export type DesktopPathInput = {
  env: Record<string, string | undefined>;
  /** 注入以便测试；默认 `os.homedir()`。 */
  home?: string;
  /** 注入以便测试；默认 `process.platform`。 */
  platform?: NodeJS.Platform;
};

/** 应用数据根目录（不含 `data` 子目录）。 */
export function resolveDesktopDataDir(input: DesktopPathInput): string {
  const explicit = input.env.LOOMIC_DATA_DIR?.trim();
  if (explicit) {
    return explicit;
  }

  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;

  if (platform === "win32") {
    const localAppData = input.env.LOCALAPPDATA?.trim();
    const base = localAppData || join(home, "AppData", "Local");
    return join(base, "KenFutWork", "data");
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "KenFutWork");
  }

  const xdgDataHome = input.env.XDG_DATA_HOME?.trim();
  const base = xdgDataHome || join(home, ".local", "share");
  return join(base, "KenFutWork");
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
};

export function resolveDesktopPaths(dataDir: string): DesktopPaths {
  return {
    dataDir,
    blobDir: join(dataDir, "blobs"),
    pgDataDir: join(dataDir, "postgres"),
    pgLogFile: join(dataDir, "logs", "postgres.log"),
    pgPasswordFile: join(dataDir, "postgres-password"),
    pluginsDir: join(dataDir, "plugins"),
  };
}
