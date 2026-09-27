import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";

import type {
  ExecShadowGit,
  ShadowGitCommandResult,
} from "./shadow-git-client.js";

/**
 * 影子 git 的真实执行：把定稿的 `args` 交给 git 二进制，作用域由 **env** 给出——
 * `GIT_DIR` 指向服务端数据目录里的影子仓库，`GIT_WORK_TREE` 指向沙箱工作目录。
 * 两个变量在 `process.env` 基础上覆盖，其余环境（PATH 等）原样继承。
 *
 * 与 code-git 的 `createProcessGitExec` 同款约束：`execFile` 无 shell（参数不被
 * 二次解释）、超时 / windowsHide / maxBuffer 同款。每次调用自动前置
 * `--no-optional-locks`：影子仓库会被并发触达（打检查点与恢复预览），
 * 不让 git 的可选锁互相顶掉。
 *
 * 不传 cwd：首次 ensureRepo 时 gitDir 与 workTree 都可能尚不存在，进程当前目录
 * 即可——影子模式的所有语义（仓库位置、工作区、输出路径）都由 env 决定，cwd 不参与。
 */
export function createShadowGitExec(options: {
  /** git 可执行体（绝对路径或 PATH 上的名字）。 */
  binary: string;
  /** 命令超时（毫秒）——git 挂住不该拖死调用方。 */
  timeoutMs?: number;
}): ExecShadowGit {
  const timeout = options.timeoutMs ?? 15_000;
  return (
    args: readonly string[],
    scope: { gitDir: string; workTree: string },
    input?: string,
  ): Promise<ShadowGitCommandResult> =>
    new Promise((resolve) => {
      // 桌面形态（gitDir/workTree 落数据目录）下，查询可能先于首个 agent run
      // 到达——目录尚不存在时 git 会报 fatal: Invalid path 并把原话甩到面板。
      // 这里兜底建目录（best-effort）：建不出来就让 git 的错误原样上抛。
      for (const dir of [scope.gitDir, scope.workTree]) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch {
          // 目录创建失败不拦截 git 调用——错误经 stderr 原样上抛
        }
      }
      const child = execFile(
        options.binary,
        ["--no-optional-locks", ...args],
        {
          timeout,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_DIR: scope.gitDir,
            GIT_WORK_TREE: scope.workTree,
          },
        },
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
        child.stdin?.end(input);
      }
    });
}
