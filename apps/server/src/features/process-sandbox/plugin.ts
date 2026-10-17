import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { resolveEntryRoot } from "../../desktop/entry-root.js";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  checkpointWorkRoots,
  resolveCheckpointGitDirectory,
} from "../checkpoints/git-directory.js";
import { resolveProcessRuntime } from "./runtime-paths.js";
import { createProcessSandbox } from "./service.js";

/** 仅由可信 provider 从 Task 授权根签发，不能从模型 argv/env 获取路径。 */
export async function resolveCheckpointWriteRoots(
  checkpointRoot: string,
  scope: CodeExecutionScope,
): Promise<string[]> {
  const roots: string[] = [];
  for (const workRoot of checkpointWorkRoots(scope)) {
    const gitDir = await resolveCheckpointGitDirectory(
      checkpointRoot,
      scope,
      workRoot,
    );
    await mkdir(gitDir, { recursive: true });
    roots.push(gitDir);
  }
  return roots;
}

/** Profile 自带执行能力；模型参数不能签发内部 checkpoint 目录授权。 */
export function createProcessSandboxPlugin(): PluginDefinition {
  return {
    name: "process-sandbox",
    inject: ["executionScopes"],
    apply(ctx) {
      const dataRoot = resolve(ctx.env.checkpointRoot ?? "data/checkpoints");
      const entryFileUrl = import.meta.url.startsWith("file:")
        ? new URL("../../server.ts", import.meta.url).href
        : import.meta.url;
      const resourceRoot = resolveEntryRoot({
        entryFileUrl,
        execPath: process.execPath,
      });
      ctx.register("processSandbox", () =>
        createProcessSandbox({
          ...resolveProcessRuntime({
            resourceRoot,
            env: process.env,
            ...(ctx.env.gitBinDir ? { gitBinDir: ctx.env.gitBinDir } : {}),
          }),
          captureRoot: join(dirname(dataRoot), "execution-output"),
          network: { allowedDomains: [], deniedDomains: [] },
          onSnapshot: (snapshot) => {
            for (const registration of ctx
              .get("capabilities")
              .list<{ receive: (value: typeof snapshot) => Promise<void> }>(
                "process-snapshot",
              )) {
              void registration.value
                .receive(snapshot)
                .catch((error: unknown) =>
                  console.error(
                    "[process-sandbox] 输出记录持久化失败：",
                    error,
                  ),
                );
            }
          },
          resolveInternalWriteRoots: (scope) =>
            resolveCheckpointWriteRoots(dataRoot, scope),
        }),
      );
    },
    mounted(ctx) {
      const sandbox = ctx.get("processSandbox");
      ctx.effect(() =>
        ctx
          .get("executionScopes")
          .onRevoke(({ previous, next }) =>
            sandbox.applyScopeChange(previous, next, "Task 目录或权限发生变更"),
          ),
      );
      ctx.app.addHook("onClose", async () => {
        console.log("[shutdown] 关闭Task执行helper。");
        await sandbox.close("执行宿主关闭");
        console.log("[shutdown] Task执行helper已关闭。");
      });
    },
  };
}
