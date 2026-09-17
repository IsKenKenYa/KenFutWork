import { join } from "node:path";

import { registerCodeGitRoutes } from "../../http/code-git.js";
import { registerCodeIndexRoutes } from "../../http/code-index.js";
import { createCodeIndexStore } from "../code-index/index-store.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createCodeGitService } from "./code-git-service.js";
import { createGitClient } from "./git-client.js";
import { createProcessGitExec } from "./git-exec.js";

/**
 * Code 模式 git 插件：分支视图服务 + HTTP 路由（路由注册放 mounted）。
 *
 * git 二进制来源与「本地优先、随包兜底」一致：`env.gitBinDir` 有值说明宿主**没有** git
 * （随包 git 已就位），否则用 PATH 上的 `git`（宿主自带）。`env.gitSource` 直接把
 * system / bundled / unavailable 透给界面，缺 git 时能说清原因而不是给个空下拉。
 */
export function createCodeGitPlugin(): PluginDefinition {
  return {
    name: "code-git",
    inject: ["auth", "persistence", "settings", "viewer"],
    apply(ctx) {
      const gitBinDir = ctx.env.gitBinDir;
      ctx.register("codeGit", () =>
        createCodeGitService({
          canvasRepository: createCanvasRepository(ctx.get("persistence")),
          git: createGitClient({
            exec: createProcessGitExec({
              binary: gitBinDir ? join(gitBinDir, "git.exe") : "git",
            }),
          }),
          source: ctx.env.gitSource ?? (gitBinDir ? "bundled" : "system"),
          canvasWorkDirs: ctx.env.canvasWorkDirs,
          sandboxRoot: ctx.env.sandboxRoot,
          viewerService: ctx.get("viewer"),
          /* 终端默认 shell 来自工作区设置（/api/settings 的 terminalShell） */
          settingsService: ctx.get("settings"),
        }),
      );
    },
    mounted(ctx) {
      void registerCodeGitRoutes(ctx.app, {
        auth: ctx.get("auth"),
        codeGitService: ctx.get("codeGit"),
      });
      // 索引库（R4-3）：数据落本机 `<cwd>/.kenfutwork/index`，不进库表
      void registerCodeIndexRoutes(ctx.app, {
        auth: ctx.get("auth"),
        codeGitService: ctx.get("codeGit"),
        settingsService: ctx.get("settings"),
        indexStore: createCodeIndexStore({}),
      });
    },
  };
}
