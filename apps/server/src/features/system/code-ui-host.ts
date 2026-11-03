import { homedir } from "node:os";

import type { IntegratedTerminalShellOption, SystemInfo } from "@zcode/shared";
import {
  listIntegratedTerminalShellOptions,
  type TerminalShellOption,
} from "../code-git/terminal-runner.js";
import type { CodeUiHostRpcHandler } from "../code-ui/host-rpc-handler.js";

/**
 * 设置页读取的 system 宿主方法。
 *
 * `system.info` 给设置页提供平台与家目录（Windows 才展示「集成终端 Shell」）；
 * `system.listIntegratedTerminalShells` 与终端下拉共用 `detectTerminalShells` 的探测结果，
 * 不再另造一套 shell 枚举，避免界面写着一个、实际能用的是另一个。
 */
export interface CodeUiSystemHostOptions {
  platform?: NodeJS.Platform;
  resolveHomedir?: () => string;
  /** 测试注入；默认走真实探测。 */
  detectShells?: () => readonly TerminalShellOption[];
}

export function createCodeUiSystemHost(
  options: CodeUiSystemHostOptions = {},
): Record<string, CodeUiHostRpcHandler> {
  const platform = options.platform ?? process.platform;
  const resolveHomedir = options.resolveHomedir ?? homedir;

  return {
    "system.info": {
      async call(): Promise<SystemInfo> {
        return { homedir: resolveHomedir(), platform };
      },
    },
    "system.listIntegratedTerminalShells": {
      async call(): Promise<IntegratedTerminalShellOption[]> {
        if (platform !== "win32") return [];
        return listIntegratedTerminalShellOptions(options.detectShells?.());
      },
    },
  };
}
