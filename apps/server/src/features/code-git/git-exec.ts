import { execFile } from "node:child_process";

import type { ExecGit, GitCommandResult } from "./git-client.js";

/**
 * 真实 git 执行：把定稿的 `args` 交给 git 二进制，在沙箱目录里跑。
 *
 * 二进制来源（顺序与「git 优先本地、打包兜底」一致）：
 *   1. 显式 `KENFUTWORK_GIT_BIN_DIR`；
 *   2. 随包 git（`<exeDir>/runtime/git/cmd`，仅当宿主没有 git 时才由 runtimes 解析出来）；
 *   3. 兜底用 PATH 上的 `git`（宿主的本地 git）。
 *
 * 不解析 shell 字符串：`execFile` 直接传数组，参数不会被 shell 二次解释。
 */
export function createProcessGitExec(options: {
  /** git 可执行体（绝对路径或 PATH 上的名字）。 */
  binary: string;
  /** 命令超时（毫秒）——git 挂住不该拖死 HTTP 请求。 */
  timeoutMs?: number;
}): ExecGit {
  const timeout = options.timeoutMs ?? 15_000;
  return (
    args: readonly string[],
    cwd: string,
    input?: string,
  ): Promise<GitCommandResult> =>
    new Promise((resolve) => {
      const child = execFile(
        options.binary,
        [...args],
        { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          // execFile 非零退出走 error（带 code）；超时/找不到二进制也走 error
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 128
                : 0;
          resolve({
            code,
            stderr: String(stderr ?? "") || (error ? error.message : ""),
            stdout: String(stdout ?? ""),
          });
        },
      );
      if (input !== undefined) {
        // `git apply` 从 stdin 读 patch；写完就关，否则 git 会一直等
        child.stdin?.end(input);
      }
    });
}
