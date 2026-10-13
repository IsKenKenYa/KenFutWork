import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveEntryRoot } from "../../desktop/entry-root.js";
import { shadowRepositoryPath } from "../checkpoints/shadow-repo-path.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { resolveProcessRuntime } from "./runtime-paths.js";
import { createProcessSandbox } from "./service.js";

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
          ...resolveProcessRuntime({ resourceRoot, env: process.env }),
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
          // checkpoint 私有写根 = 短布局影子仓库目录（与 checkpoint-service 同一公式；
          // 旧三层布局在短布局改造后是死路径，spawnCheckpoint 的 realpath 直接 ENOENT
          // ——2026-10-13 实测事故）。仓库目录在「首个快照」才被创建，而 realpath 要求
          // 路径已存在：授权前先建目录，消除首拍之前的时间窗。
          resolveInternalWriteRoots: async (scope) => {
            const roots = [
              scope.rootDirectory,
              ...scope.additionalDirectories
                .filter((entry) => entry.access === "read-write")
                .map((entry) => entry.path),
            ];
            const directories = [...new Set(roots)].map((root) =>
              shadowRepositoryPath(dataRoot, scope.taskId, root),
            );
            for (const directory of directories) {
              await mkdir(directory, { recursive: true });
            }
            return directories;
          },
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
