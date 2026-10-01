/**
 * Computer Use 执行器缝（A→B 档换实现不换协议）。
 *
 * 里程碑 1 的 A 档：macOS = nut-js（截屏/输入注入）+ JXA（AX 树读取）；
 * 其余平台 = unavailable 执行器（工具显式报不可用，fail loud 不摆空壳）。
 * P3 的 B 档（独立 helper 进程 + unix socket broker）实现同一接口即可替换。
 */

import type { AxAppRef, AxNode, AxWindowRef } from "./ax-tree.js";
import type { CuTarget, ParsedAppRef } from "./target.js";

export interface CuAppInfo {
  pid: number;
  name: string | null;
  bundleId: string | null;
  active: boolean;
}

export interface CuWindowRow {
  windowId: number;
  title: string | null;
  /** 存在与否区分「AX 真窗口」与「CoreGraphics 合并行」（macOS）。 */
  subrole: string | null;
  bounds: [number, number, number, number] | null;
  main: boolean;
  focused: boolean;
}

export interface CuObservation {
  app: AxAppRef;
  window: AxWindowRef;
  root: AxNode;
}

export interface CuRaster {
  frameId: string;
  mimeType: "image/png";
  width: number;
  height: number;
  base64: string;
  /** 捕获内容黑帧检测结果（内容判定，不信权限查询单边结论）。 */
  blackFrame: boolean;
}

export interface CuActionResult {
  /** 动作是否已（可能已）到达目标 app。 */
  actionSent: boolean;
  detail: string;
}

export interface CuAccessStatus {
  accessibility: "granted" | "denied" | "not_determined";
  screen: "granted" | "denied" | "not_determined";
  hint: string;
}

export interface ComputerUseExecutor {
  /** 执行器标识（"macos-nutjs-jxa" / "unavailable"）。 */
  readonly id: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  listApps(): Promise<CuAppInfo[]>;
  listWindows(appRef: ParsedAppRef): Promise<CuWindowRow[]>;
  observe(appRef: ParsedAppRef): Promise<CuObservation>;
  capture(appRef: ParsedAppRef): Promise<CuRaster>;
  click(appRef: ParsedAppRef, target: CuTarget): Promise<CuActionResult>;
  typeText(
    appRef: ParsedAppRef,
    text: string,
    target?: CuTarget,
  ): Promise<CuActionResult>;
  accessStatus(): Promise<CuAccessStatus>;
  stop(): Promise<void>;
}

export function createUnavailableExecutor(reason: string): ComputerUseExecutor {
  const refuse = async (): Promise<never> => {
    throw new Error(`Computer Use 在此环境不可用：${reason}`);
  };
  return {
    id: "unavailable",
    available: false,
    unavailableReason: reason,
    listApps: refuse,
    listWindows: refuse,
    observe: refuse,
    capture: refuse,
    click: refuse,
    typeText: refuse,
    accessStatus: refuse,
    stop: async () => {},
  };
}

/**
 * 平台分派：darwin 走 macOS 执行器（动态 import，原生包不进非 mac 加载路径）；
 * 其余平台显式 unavailable。P3 增 Windows/Linux 分支。
 */
export async function createExecutorForPlatform(options: {
  platform?: NodeJS.Platform;
  actionTimeoutMs?: number;
  log?: (message: string) => void;
}): Promise<ComputerUseExecutor> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    try {
      const { createMacosExecutor } = await import("./executor-macos.js");
      return createMacosExecutor(
        options.actionTimeoutMs !== undefined
          ? { actionTimeoutMs: options.actionTimeoutMs }
          : {},
      );
    } catch (error) {
      options.log?.(
        `[computer-use] macOS 执行器加载失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return createUnavailableExecutor(
        `macOS 执行器加载失败（${
          error instanceof Error ? error.message : String(error)
        }）`,
      );
    }
  }
  return createUnavailableExecutor(
    `当前平台 ${platform} 尚未实现 Computer Use 执行器（里程碑 1 仅支持 darwin）。`,
  );
}
