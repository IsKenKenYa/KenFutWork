/**
 * Computer Use 插件（内核代码级，双层插件的「重活」层）。
 *
 * 分工（对齐 FORM-11 flow 范式）：
 * - `plugins/computer-use/`（市场 bundle）= 产品入口：安装态决定能力是否可用；
 * - 本插件 = 能力实现：ctx.tools 注册桌面原语与后端选择工具
 *   （scope: "code"，只在 Code 模式主 agent 可见；子代理白名单制天然隔离）。
 *
 * 门控在**调用时**读安装态（browser 插件同款纪律：注册期 plugins 可能未装配、
 * 且安装/卸载/停用是运行期动作）。执行器按平台异步装配；原生层未就绪时
 * 保持 unavailable，工具显式报不可用。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  clampComputerUseActionTimeoutMs,
  clampComputerUseMaxActionsPerRun,
  clampComputerUseObserveMaxBytes,
  clampComputerUseScreenshotMaxBytes,
  clampComputerUseSessionMaxMs,
} from "@kenfutwork/shared";
import { z } from "zod";
import type { ServerEnv } from "../../config/env.js";
import { registerComputerUseMcpRoutes } from "../../http/computer-use-mcp.js";
import { registerComputerUseSnapshotRoutes } from "../../http/computer-use-snapshots.js";
import type {
  PluginDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
} from "../code-ui/host-rpc-handler.js";
import { createMacosPermissionStatusRpc } from "./permission-status-rpc.js";
import { createActiveComputerUseRuns } from "./active-runs.js";
import { createMacosApplicationIconResolver } from "./application-icon.js";
import { createUnavailableExecutor } from "./executor.js";
import {
  type ComputerUseMcpSource,
  createMcpComputerUseExecutor,
} from "./mcp-backend.js";
import {
  type ComputerUseMcpExport,
  createComputerUseMcpServer,
} from "./mcp-server.js";
import {
  type CuGovernanceValues,
  createComputerUseService,
} from "./service.js";
import { createCuSnapshotArchive } from "./snapshot-archive.js";
import {
  CU_BUNDLE_ID,
  type CuGateVerdict,
  createComputerUseTools,
} from "./tools.js";

/** 插件注册表的最小结构面（避免与 features/plugins 的具体类型硬耦合）。 */
interface PluginsServiceLike {
  list(): Promise<
    Array<{ id: string; name: string; installed: boolean; enabled?: boolean }>
  >;
}

function resolveGovernance(env: ServerEnv): CuGovernanceValues {
  const overrides = env.agentGovernance ?? {};
  const gov = (
    setting:
      | "computerUseActionTimeoutMs"
      | "computerUseObserveMaxBytes"
      | "computerUseScreenshotMaxBytes"
      | "computerUseMaxActionsPerRun"
      | "computerUseSessionMaxMs",
    clamp: (value: number) => number,
  ): number => {
    const override = overrides[setting];
    if (override !== undefined) return clamp(override);
    const fallback = AGENT_GOVERNANCE_DEFAULTS[setting] as number;
    return clamp(fallback);
  };
  return {
    actionTimeoutMs: gov(
      "computerUseActionTimeoutMs",
      clampComputerUseActionTimeoutMs,
    ),
    observeMaxBytes: gov(
      "computerUseObserveMaxBytes",
      clampComputerUseObserveMaxBytes,
    ),
    screenshotMaxBytes: gov(
      "computerUseScreenshotMaxBytes",
      clampComputerUseScreenshotMaxBytes,
    ),
    maxActionsPerRun: gov(
      "computerUseMaxActionsPerRun",
      clampComputerUseMaxActionsPerRun,
    ),
    sessionMaxMs: gov("computerUseSessionMaxMs", clampComputerUseSessionMaxMs),
  };
}

function createBundleGate(
  tryGetPlugins: () => PluginsServiceLike | undefined,
): () => Promise<CuGateVerdict> {
  return async () => {
    const plugins = tryGetPlugins();
    if (!plugins) {
      return {
        ok: false,
        message:
          "插件注册表不可用：无法确认 Computer Use 安装状态（fail closed）。",
      };
    }
    try {
      const entries = await plugins.list();
      const entry = entries.find(
        (candidate) =>
          candidate.id === CU_BUNDLE_ID || candidate.name === CU_BUNDLE_ID,
      );
      if (!entry || !entry.installed) {
        return {
          ok: false,
          message: `Computer Use 插件未安装：请在工作台「插件市场」安装 ${CU_BUNDLE_ID} 后重试。`,
        };
      }
      if (entry.enabled === false) {
        return {
          ok: false,
          message: "Computer Use 插件已停用：请在「插件市场」重新启用后重试。",
        };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: `插件状态查询失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };
}

export function createComputerUsePlugin(options?: {
  platform?: NodeJS.Platform;
}): PluginDefinition {
  return {
    name: "computer-use",
    inject: ["settings", "localAccess", "localInstance", "blob", "persistence"],
    apply(ctx) {
      if ((options?.platform ?? process.platform) === "darwin") {
        const icons = createMacosApplicationIconResolver();
        const controller = new AbortController();
        const iconRpc: CodeUiHostRpcHandler = {
          async call(actor, args) {
            const [request] = z.tuple([z.unknown()]).parse(args);
            const settings = await ctx
              .get("settings")
              .getInstanceSettings(actor, actor.instanceId);
            return icons.read(request, {
              signal: controller.signal,
              timeoutMs: settings.computerUseActionTimeoutMs,
              maxBytes: settings.processMaxOutputBytes,
            });
          },
        };
        ctx.effect(() =>
          ctx
            .get("capabilities")
            .register(CODE_UI_HOST_RPC_CAPABILITY, {
              id: "platform.getApplicationIcon",
              value: iconRpc,
            }),
        );
        ctx.effect(() => () => controller.abort());
      }
      const runGovernance = new AsyncLocalStorage<CuGovernanceValues>();
      const archive = createCuSnapshotArchive({
        blob: ctx.get("blob"),
        persistence: ctx.get("persistence"),
      });
      registerComputerUseSnapshotRoutes(ctx.app, {
        archive,
        localAccess: ctx.get("localAccess"),
        settings: ctx.get("settings"),
      });
      const executionContext = new AsyncLocalStorage<ToolExecutionContext>();
      let disposed = false;
      let selected = "native";
      let native = createUnavailableExecutor("平台执行器装配中。");
      const service = createComputerUseService({
        executor: createUnavailableExecutor("平台执行器装配中。"),
        governance: () =>
          runGovernance.getStore() ?? resolveGovernance(ctx.env),
      });

      const gate = createBundleGate(
        () => ctx.tryGet("plugins") as PluginsServiceLike | undefined,
      );
      if ((options?.platform ?? process.platform) === "darwin") {
        const permissionRpc = createMacosPermissionStatusRpc({
          gate,
          executor: () => native,
          timeoutMs: async (actor) => (await ctx.get("settings").getInstanceSettings(actor, actor.instanceId)).computerUseActionTimeoutMs,
        });
        ctx.effect(() =>
          ctx.get("capabilities").register(CODE_UI_HOST_RPC_CAPABILITY, {
            id: "cua-permission.getStatus",
            value: permissionRpc,
          }),
        );
      }
      const tools = ctx.get("tools");
      const activeRuns = createActiveComputerUseRuns(tools);
      ctx.effect(() =>
        ctx.get("capabilities").register("agent-run-extension", {
          id: "computer-use:active-main-run",
          value: activeRuns.extension,
        }),
      );
      const exporter: ComputerUseMcpExport = {
        assertRun: (actor, runId) => activeRuns.assertRun(actor, runId),
        createServer: (actor, runId) => {
          activeRuns.assertRun(actor, runId);
          return createComputerUseMcpServer({
            registry: tools,
            version: ctx.env.version,
            resolveContext: async (signal) =>
              activeRuns.resolveContext(actor, runId, signal),
            execute: (name, args, execution) =>
              activeRuns.execute(actor, runId, name, args, execution),
          });
        },
      };
      ctx.effect(() =>
        ctx.get("capabilities").register("computer-use-mcp-export", {
          id: "computer-use:trusted-run",
          value: exporter,
        }),
      );
      const http = registerComputerUseMcpRoutes(ctx.app, {
        exporter,
        localAccess: ctx.get("localAccess"),
        localInstance: ctx.get("localInstance"),
        settings: ctx.get("settings"),
      });
      const external = async (context: ToolExecutionContext) =>
        (
          await Promise.all(
            ctx
              .get("capabilities")
              .list<ComputerUseMcpSource>("computer-use-mcp-source")
              .map((source) => source.value.list(context)),
          )
        ).flat();
      const backends = {
        list: async (context: ToolExecutionContext) => ({
          content: [
            {
              type: "text" as const,
              text: "桌面后端来自本机provider与原MCP库存",
            },
          ],
          structuredContent: {
            selected,
            backends: [
              {
                id: "native",
                name: native.id,
                available: native.available,
                reason: native.unavailableReason,
              },
              ...(await external(context)).map((connection) => ({
                id: `mcp:${connection.id}`,
                name: connection.name,
                available: true,
              })),
            ],
          },
        }),
        select: async (id: string, context: ToolExecutionContext) => {
          const runId = context.runId;
          if (!runId) throw new Error("后端选择缺少可信Run身份");
          const connection =
            id === "native"
              ? undefined
              : (await external(context)).find(
                  (candidate) => `mcp:${candidate.id}` === id,
                );
          if (id !== "native" && !connection)
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "选中的桌面MCP连接不存在、未就绪或不支持已声明的协议",
                },
              ],
            };
          const next = connection
            ? createMcpComputerUseExecutor(
                connection,
                () => executionContext.getStore() ?? context,
              )
            : native;
          const result = await service.replaceExecutor(next, runId);
          if (!result.isError) selected = id;
          return result;
        },
      };
      for (const definition of createComputerUseTools({
        service,
        gate,
        backends,
      })) {
        ctx.effect(() =>
          tools.register({
            ...definition,
            async execute(args, context) {
              const actor = context.actor;
              const work = context.taskWorkContext;
              const scope = context.scopeHandle?.describe();
              if (
                !actor ||
                !work ||
                !work.actor ||
                !scope ||
                !context.runId ||
                !context.toolCallId ||
                work.runId !== context.runId ||
                context.scopeHandle?.role !== "main" ||
                actor.instanceId !== context.instanceId ||
                actor.instanceId !== work.actor.instanceId ||
                actor.instanceId !== scope.instanceId ||
                work.scope.instanceId !== scope.instanceId ||
                work.scope.taskId !== scope.taskId ||
                work.scope.projectId !== scope.projectId
              )
                return {
                  isError: true,
                  content: [
                    { type: "text", text: "桌面控制缺少可信实例和Task上下文" },
                  ],
                  structuredContent: {
                    error: { code: "context_required", actionSent: false },
                  },
                };
              const settings = await ctx
                .get("settings")
                .getInstanceSettings(actor, actor.instanceId);
              const governance: CuGovernanceValues = {
                actionTimeoutMs: settings.computerUseActionTimeoutMs,
                observeMaxBytes: settings.computerUseObserveMaxBytes,
                screenshotMaxBytes: settings.computerUseScreenshotMaxBytes,
                maxActionsPerRun: settings.computerUseMaxActionsPerRun,
                sessionMaxMs: settings.computerUseSessionMaxMs,
                axMaxDepth: settings.computerUseAxMaxDepth,
                axMaxChildren: settings.computerUseAxMaxChildren,
                axTitleMaxChars: settings.computerUseAxTitleMaxChars,
                axValueMaxChars: settings.computerUseAxValueMaxChars,
                axMaxActions: settings.computerUseAxMaxActions,
                inputDelayMs: settings.computerUseInputDelayMs,
                processMaxOutputBytes: settings.processMaxOutputBytes,
              };
              const result = await executionContext.run(context, () =>
                runGovernance.run(governance, () =>
                  definition.execute(args, context),
                ),
              );
              return archive.project(
                result as import("./service.js").CuToolResult,
                context,
              );
            },
          }),
        );
      }

      // 执行器异步装配：非 darwin / 原生层缺失时保持 unavailable（fail loud）
      const cuGovernance = resolveGovernance(ctx.env);
      void import("./executor.js")
        .then(({ createExecutorForPlatform }) =>
          createExecutorForPlatform({
            ...(options?.platform !== undefined
              ? { platform: options.platform }
              : {}),
            actionTimeoutMs: cuGovernance.actionTimeoutMs,
            log: (message) => console.warn(message),
          }),
        )
        .then(async (executor) => {
          if (disposed) {
            await executor.stop();
            return;
          }
          native = executor;
          if (selected === "native") service.setExecutor(executor);
          if (!executor.available) {
            console.warn(
              `[computer-use] ${executor.unavailableReason ?? "执行器不可用"}`,
            );
          }
        })
        .catch((error: unknown) => {
          console.warn(
            "[computer-use] 执行器装配失败：",
            error instanceof Error ? error.message : String(error),
          );
        });

      // run 结束释放控制租约（防泄漏的租约把后续 run 全挡在 controller_busy）
      ctx.on("turn-stopping", async (_payload, next) => {
        activeRuns.closeRun(_payload.runId);
        await http.closeRun(_payload.runId);
        await next();
        await service.releaseLease(_payload.runId);
      });

      ctx.effect(() => async () => {
        disposed = true;
        activeRuns.dispose();
        await http.dispose();
        await service.dispose();
      });
    },
  };
}
