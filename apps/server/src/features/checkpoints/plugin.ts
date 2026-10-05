import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { registerCheckpointsRoutes } from "../../http/checkpoints.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { acquireTaskFileRestoreBarrier } from "../execution/scoped-filesystem.js";
import { createCheckpointService } from "./checkpoint-service.js";
import { createCheckpointRepository } from "./repository.js";
import { createShadowGitClient } from "./shadow-git-client.js";
import { createShadowGitExec } from "./shadow-git-exec.js";

export function createCheckpointsPlugin(): PluginDefinition {
  return {
    name: "checkpoints",
    inject: [
      "localAccess",
      "persistence",
      "settings",
      "executionScopes",
      "processSandbox",
    ],
    apply(ctx) {
      const gitBinDir = ctx.env.gitBinDir;
      const binary = gitBinDir
        ? join(gitBinDir, process.platform === "win32" ? "git.exe" : "git")
        : "git";
      ctx.register("checkpoints", () =>
        createCheckpointService({
          repository: createCheckpointRepository(ctx.get("persistence")),
          gitSource: ctx.env.gitSource ?? (gitBinDir ? "bundled" : "system"),
          checkpointRoot: resolve(ctx.env.checkpointRoot ?? "data/checkpoints"),
          gitForScope: async (scope, actor) => {
            const settings = await ctx
              .get("settings")
              .getInstanceSettings(actor, scope.describe().instanceId);
            return createShadowGitClient({
              // Git 只读用户目录，系统 authority 仅开放 Task 私有 metadata。
              exec: createShadowGitExec({
                scope: scope.derive("review", "checkpoint-git"),
                sandbox: ctx.get("processSandbox"),
                binary,
                timeoutMs: settings.executeTimeoutMs,
                limits: {
                  maxOutputBytes: settings.processMaxOutputBytes,
                  previewMaxChars: settings.processPreviewMaxChars,
                  yieldMs: settings.processYieldMs,
                  killGraceMs: settings.processKillGraceMs,
                },
              }),
              writeTextFile: async (path, text) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, text, "utf8");
              },
            });
          },
          files: {
            observe: (scope, path) => scope.backend.observeBinary(path),
            commit: async (scope, entries, beforeCommit) => {
              let next = scope;
              const result = await scope.backend.commitBatch(
                entries,
                async () => {
                  next = await beforeCommit();
                  return next;
                },
              );
              if (!result.complete || result.failures.length)
                throw new Error(
                  result.failures.map((failure) => failure.error).join("\n") ||
                    "文件恢复未完整完成",
                );
              return next;
            },
          },
          acquireRestoreBarrier: async (scope, roots) => {
            const processLease = await ctx
              .get("processSandbox")
              .acquireRestoreBarrier(scope.describe(), roots);
            try {
              const fileLease = await acquireTaskFileRestoreBarrier(
                scope,
                roots,
              );
              return {
                authorize: (next) => fileLease.authorize(next),
                release: async () => {
                  try {
                    await fileLease.release();
                  } finally {
                    await processLease.release();
                  }
                },
              };
            } catch (error) {
              await processLease.release();
              throw error;
            }
          },
          onBeforeRestore: (scope, actor) =>
            ctx
              .get("codeUi")
              .rewindTask(
                actor,
                scope.describe().taskId,
                scope.describe().generation,
              ),
          onAfterRestore: (scope, actor, success) =>
            ctx.get("codeUi").finishTaskRestore(scope, actor, success),
        }),
      );
    },
    mounted(ctx) {
      ctx.get("capabilities").register("task-close", {
        id: "checkpoints:restore-previews",
        value: {
          close: (instanceId: string, taskId: string) =>
            ctx.get("checkpoints").forgetTask(instanceId, taskId),
        },
      });
      ctx.effect(() =>
        ctx.get("executionScopes").onRevoke(async ({ previous }) => {
          ctx
            .get("checkpoints")
            .forgetTask(previous.instanceId, previous.taskId);
        }),
      );
      void registerCheckpointsRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        executionScopes: ctx.get("executionScopes"),
        checkpointsService: ctx.get("checkpoints"),
      });
    },
  };
}
