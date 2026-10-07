import { join } from "node:path";
import { resolveDesktopDataDir } from "../../desktop/paths.js";

import { registerCodeGitRoutes } from "../../http/code-git.js";
import { registerCodeIndexRoutes } from "../../http/code-index.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createCodeIndexStore } from "../code-index/index-store.js";
import { createCodeGitService } from "./code-git-service.js";
import { createGitClient } from "./git-client.js";
import { createScopedGitExec } from "./scoped-git-exec.js";

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
    inject: [
      "localAccess",
      "settings",
      "localInstance",
      "executionScopes",
      "processSandbox",
    ],
    apply(ctx) {
      const gitBinDir = ctx.env.gitBinDir;
      ctx.register("codeGit", () =>
        createCodeGitService({
          scopes: ctx.get("executionScopes"),
          processSandbox: ctx.get("processSandbox"),
          gitForScope: async (scope, actor) => {
            const settings = await ctx
              .get("settings")
              .getInstanceSettings(actor, scope.describe().instanceId);
            return createGitClient({
              exec: createScopedGitExec({
                scope,
                sandbox: ctx.get("processSandbox"),
                binary: gitBinDir
                  ? join(
                      gitBinDir,
                      process.platform === "win32" ? "git.exe" : "git",
                    )
                  : "git",
                timeoutMs: settings.executeTimeoutMs,
                limits: {
                  maxOutputBytes: settings.processMaxOutputBytes,
                  previewMaxChars: settings.processPreviewMaxChars,
                  yieldMs: settings.processYieldMs,
                  killGraceMs: settings.processKillGraceMs,
                },
              }),
            });
          },
          source: ctx.env.gitSource ?? (gitBinDir ? "bundled" : "system"),
          localInstance: ctx.get("localInstance"),
          /* 终端默认 shell 来自工作区设置（/api/settings 的 terminalShell） */
          settingsService: ctx.get("settings"),
        }),
      );
    },
    mounted(ctx) {
      void registerCodeGitRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        codeGitService: ctx.get("codeGit"),
      });
      // 可重建的本机索引也随实例数据根迁移。
      void registerCodeIndexRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        codeGitService: ctx.get("codeGit"),
        settingsService: ctx.get("settings"),
        indexStore: createCodeIndexStore({
          indexDir: join(
            resolveDesktopDataDir({
              env: { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir },
            }),
            "index",
          ),
        }),
      });

    },
  };
}
