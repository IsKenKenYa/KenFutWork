import { execFileSync } from "node:child_process";
import type { ExecShadowGit } from "./shadow-git-client.js";

/** 保留实际 Git 维护，等待打包进程结束后才允许测试清理临时仓库。 */
export const execTestShadowGit: ExecShadowGit = async (args, scope, input) => {
  try {
    const stdout = execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "maintenance.autoDetach=false",
        "-c",
        "gc.autoDetach=false",
        ...args,
      ],
      {
        cwd: scope.workTree,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: scope.gitDir,
          GIT_WORK_TREE: scope.workTree,
        },
        ...(input === undefined ? {} : { input }),
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      },
    );
    return { code: 0, stderr: "", stdout };
  } catch (error) {
    const failure = error as {
      status?: number;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    return {
      code: failure.status ?? 1,
      stderr: failure.stderr?.toString() ?? "失败",
      stdout: failure.stdout?.toString() ?? "",
    };
  }
};
