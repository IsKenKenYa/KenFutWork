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

/**
 * 权限策略里的域名规则 → 沙箱网络名单（设置 → 权限 → 网络安全）。
 *
 * 沙箱默认 `strictAllowlist: true`：白名单为空即**全部出站被拦**。
 * 因此这里只把 `allow` 规则放进白名单；`deny` 规则同时进黑名单（即便也被写进白名单）。
 * 抽成纯函数便于单测：错位的映射会让「我允许了却连不上 / 我拒绝了却连得上」这类问题
 * 只能靠真实命令复现。
 */
export function sandboxNetworkFor(
  domainRules: ReadonlyArray<{ domain: string; action: string }>,
): { allowedDomains: string[]; deniedDomains: string[] } {
  return {
    allowedDomains: domainRules
      .filter((rule) => rule.action === "allow")
      .map((rule) => rule.domain),
    deniedDomains: domainRules
      .filter((rule) => rule.action === "deny")
      .map((rule) => rule.domain),
  };
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
          /**
           * 沙箱网络策略（设置 → 权限 → 网络安全）。
           *
           * 沙箱默认 `strictAllowlist: true`，域名单为空即**全部出站被拦**。
           * 权限策略里的域名规则因此是这张名单的唯一来源：
           * - `allow` 规则进白名单（沙箱放行这些域名）；
           * - `deny` 规则进黑名单（即便在白名单里也拦）。
           *
           * 每次启动命令都重新读（设置是运行期可改的）；未装配 permissions 时
           * 维持空名单（全部拦下），与改造前一致。
           */
          resolveNetwork: async () => {
            const permissions = ctx.tryGet("permissions");
            const domainRules =
              permissions?.getSettings().policy.domainRules ?? [];
            return sandboxNetworkFor(domainRules);
          },
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
