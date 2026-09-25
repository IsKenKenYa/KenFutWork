import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSandboxDir } from "../../agent/sandbox-dir.js";
import { registerCheckpointsRoutes } from "../../http/checkpoints.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createCheckpointService } from "./checkpoint-service.js";
import { createCheckpointRepository } from "./repository.js";
import { createShadowGitClient } from "./shadow-git-client.js";
import { createShadowGitExec } from "./shadow-git-exec.js";

/**
 * 检查点插件（Code 模式影子 git）：服务 + HTTP 路由（路由注册放 mounted）。
 *
 * git 二进制来源与 code-git 一致：宿主自带优先（PATH 上的 `git`），随包兜底
 * （`env.gitBinDir`，仅在宿主没有 git 时有值）。二进制名按平台解析——Windows
 * 随包布局是 `cmd/git.exe`，POSIX 是裸 `git`；仓库里没有统一的跨平台解析处，
 * 这里就地一行三元组（不复制 code-git plugin 写死 `git.exe` 的做法）。
 *
 * `checkpointRoot` 由入口注入（server.ts resolveCheckpointRoot，缺省
 * `<entryRoot>/data/checkpoints`）；`sandboxRoot` 透传给服务，使恢复操作与
 * agent 后端落在同一个工作目录。
 */
export function createCheckpointsPlugin(): PluginDefinition {
  return {
    name: "checkpoints",
    inject: ["auth", "persistence", "viewer"],
    apply(ctx) {
      const gitBinDir = ctx.env.gitBinDir;
      const gitBinary = gitBinDir
        ? join(gitBinDir, process.platform === "win32" ? "git.exe" : "git")
        : "git";
      ctx.register("checkpoints", () =>
        createCheckpointService({
          repository: createCheckpointRepository(ctx.get("persistence")),
          canvasRepository: createCanvasRepository(ctx.get("persistence")),
          git: createShadowGitClient({
            exec: createShadowGitExec({ binary: gitBinary }),
            writeTextFile: async (path, content) => {
              writeFileSync(path, content, "utf8");
            },
          }),
          gitSource: ctx.env.gitSource ?? (gitBinDir ? "bundled" : "system"),
          ...(ctx.env.checkpointRoot
            ? { checkpointRoot: ctx.env.checkpointRoot }
            : { checkpointRoot: join(process.cwd(), "data", "checkpoints") }),
          sandboxRoot: ctx.env.sandboxRoot,
          resolveSandboxDirFn: resolveSandboxDir,
        }),
      );
    },
    mounted(ctx) {
      // 在途守卫（可选依赖）：agent-runs 缺席时 restore 不做运行中拦截
      const agentRuns = ctx.tryGet("agentRuns");
      void registerCheckpointsRoutes(ctx.app, {
        auth: ctx.get("auth"),
        viewerService: ctx.get("viewer"),
        checkpointsService: ctx.get("checkpoints"),
        ...(agentRuns ? { agentRuns } : {}),
      });
    },
  };
}
