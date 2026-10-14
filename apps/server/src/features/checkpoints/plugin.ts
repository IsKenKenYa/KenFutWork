import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { registerCheckpointsRoutes } from "../../http/checkpoints.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { acquireTaskFileRestoreBarrier } from "../execution/scoped-filesystem.js";
import { createCheckpointService } from "./checkpoint-service.js";
import { createDesignLayoutFiles } from "./design-layout-files.js";
import { createDesignTaskRestore } from "./design-task-restore.js";
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
      "designRunHost",
    ],
    apply(ctx) {
      const gitBinDir = ctx.env.gitBinDir;
      const binary = gitBinDir
        ? join(gitBinDir, process.platform === "win32" ? "git.exe" : "git")
        : "git";
      ctx.register("checkpoints", () =>
        createCheckpointService({
          designRestore: createDesignTaskRestore({
            // 恢复时才取得宿主：宿主自身消费运行时，而运行时消费检查点。
            host: {
              beginRestore: (actor, input) =>
                ctx.get("designRunHost").beginRestore(actor, input),
              finishRestore: (actor, input) =>
                ctx.get("designRunHost").finishRestore(actor, input),
            },
            executionScopes: ctx.get("executionScopes"),
          }),
          forceIncludePaths: async (scope, actor, rootDirectory) =>
            rootDirectory === scope.describe().rootDirectory
              ? createDesignLayoutFiles(ctx.get("persistence"))(scope, actor)
              : [],
          repository: createCheckpointRepository(ctx.get("persistence")),
          gitSource: ctx.env.gitSource ?? (gitBinDir ? "bundled" : "system"),
          checkpointRoot: resolve(ctx.env.checkpointRoot ?? "data/checkpoints"),
          gitForScope: async (scope, actor) => {
            const settings = await ctx
              .get("settings")
              .getInstanceSettings(actor, scope.describe().instanceId);
            return createShadowGitClient({
              /**
               * 检查点 Git 是固定 argv 的系统 consumer（`spawnCheckpoint` 只接受精确 argv，
               * 模型输入到不了这里），签发**可写**作用域而不是「review」只读作用域：
               *
               * `git add` / `git commit` 内部走 `setup_work_tree()`，它必须 chdir 进工作树；
               * 而 Windows 只读授权（PSEC `fs_read_only`）不含目录 traverse，只读作用域下
               * `chdir` 直接 Permission denied —— Git 随即以
               * `fatal: this operation must be run in a work tree` 退出（真机实测，检查点
               * 时间线与每轮自动提交整族失效）。Git 自己写不了工作树：全部命令集只有
               * `--cached`/索引/私有影子仓库三个写目标，工作树只被读。
               *
               * 只读的额外目录不受影响：scope 的 per-directory access 已把它们标成
               * `read-only`，与 scope 的只读位无关；Git 的写权限仍由 `internalWriteRoots`
               * 收敛在 Task 私有影子仓库。
               */
              exec: createShadowGitExec({
                scope: scope.derive("worker", "checkpoint-git"),
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
