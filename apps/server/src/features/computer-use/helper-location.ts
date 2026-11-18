import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDesktopDataDir } from "../../desktop/paths.js";

export const CUA_HELPER_DEV_APP_NAME = "KenFutWork Computer Use Dev.app";
export const CUA_HELPER_PRODUCTION_APP_NAME = "KenFutWork Computer Use.app";

export interface ComputerUseHelperLocation {
  appPath: string;
  socketPath: string;
  configuration: "dev" | "production";
}

export function shouldEagerStartComputerUseHelper(
  env: Record<string, string | undefined>,
): boolean {
  return env.KENFUTWORK_EMBEDDED_PG === "1";
}

/**
 * Helper 位置只有两处输入：打包壳显式注入的路径，或开发数据目录下的固定安装。
 * 两者都不存在时返回 null，由设置页如实说明缺失，不能退回 Node 主进程的 TCC 身份。
 */
export function resolveComputerUseHelperLocation(input: {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  dataDir?: string;
  cwd?: string;
  exists?: (path: string) => boolean;
}): ComputerUseHelperLocation | null {
  if ((input.platform ?? process.platform) !== "darwin") return null;
  const explicit = input.env.KENFUTWORK_CUA_HELPER_PATH?.trim();
  const dataDir =
    input.dataDir ??
    (input.env.KENFUTWORK_DATA_DIR?.trim() ||
      resolveDesktopDataDir({ env: input.env }));
  if (explicit) {
    const configuration = isDevHelperPath(explicit) ? "dev" : "production";
    const socketPath = join(dataDir, "cua-helper", configuration, "h.sock");
    assertSocketPathFits(socketPath);
    return { appPath: explicit, socketPath, configuration };
  }
  if (!dataDir)
    throw new Error("缺少桌面数据目录，无法定位 Computer Use Helper。");
  // 打包形态：Helper 与 server 同属 Contents/Resources/app（cwd 由桌面壳指定）。
  const bundledAppPath = join(
    input.cwd ?? process.cwd(),
    "cua-helper",
    CUA_HELPER_PRODUCTION_APP_NAME,
  );
  if ((input.exists ?? existsSync)(bundledAppPath)) {
    const socketPath = join(dataDir, "cua-helper", "production", "h.sock");
    assertSocketPathFits(socketPath);
    return {
      appPath: bundledAppPath,
      socketPath,
      configuration: "production",
    };
  }
  const appPath = join(dataDir, "cua-helper", "dev", CUA_HELPER_DEV_APP_NAME);
  const socketPath = join(dataDir, "cua-helper", "dev", "h.sock");
  assertSocketPathFits(socketPath);
  return { appPath, socketPath, configuration: "dev" };
}

function isDevHelperPath(path: string): boolean {
  return path.endsWith(`/${CUA_HELPER_DEV_APP_NAME}`);
}

/** macOS 的 sun_path 上限是 104 字节（含结尾空字符），超长会直接绑定失败。 */
function assertSocketPathFits(socketPath: string): void {
  if (Buffer.byteLength(socketPath) <= 100) return;
  throw new Error(
    `数据目录路径过长，Computer Use Helper 的 socket 无法创建：${socketPath}`,
  );
}
