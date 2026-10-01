/**
 * Computer Use 插件（内核代码级，双层插件的「重活」层）。
 *
 * 分工（对齐 FORM-11 flow 范式）：
 * - `plugins/computer-use/`（市场 bundle）= 产品入口：安装态决定能力是否可用；
 * - 本插件 = 能力实现：ctx.tools 注册 8 个 `mcp__computer-use__<action>` 工具
 *   （scope: "code"，只在 Code 模式主 agent 可见；子代理白名单制天然隔离）。
 *
 * 门控在**调用时**读安装态（browser 插件同款纪律：注册期 plugins 可能未装配、
 * 且安装/卸载/停用是运行期动作）。执行器按平台异步装配：非 darwin 或原生层
 * 加载失败时保持 unavailable——工具显式报不可用，不摆空壳。
 */

import {
  AGENT_GOVERNANCE_DEFAULTS,
  clampComputerUseActionTimeoutMs,
  clampComputerUseMaxActionsPerRun,
  clampComputerUseObserveMaxBytes,
  clampComputerUseScreenshotMaxBytes,
  clampComputerUseSessionMaxMs,
} from "@kenfutwork/shared";
import type { ServerEnv } from "../../config/env.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createUnavailableExecutor } from "./executor.js";
import { createComputerUseService, type CuGovernanceValues } from "./service.js";
import { CU_BUNDLE_ID, createComputerUseTools, type CuGateVerdict } from "./tools.js";

/** 插件注册表的最小结构面（避免与 features/plugins 的具体类型硬耦合）。 */
interface PluginsServiceLike {
  list(): Promise<
    Array<{ id: string; name: string; installed: boolean; enabled?: boolean }>
  >;
}

function resolveGovernance(env: ServerEnv): CuGovernanceValues {
  const overrides = env.agentGovernance ?? {};
  const gov = <K extends keyof CuGovernanceValues>(
    key: K,
    clamp: (value: number) => number,
  ): number => {
    const override = (overrides as Partial<Record<K, number>>)[key];
    if (override !== undefined) return clamp(override);
    const fallback = AGENT_GOVERNANCE_DEFAULTS[
      key as keyof typeof AGENT_GOVERNANCE_DEFAULTS
    ] as number;
    return clamp(fallback);
  };
  return {
    actionTimeoutMs: gov("actionTimeoutMs", clampComputerUseActionTimeoutMs),
    observeMaxBytes: gov("observeMaxBytes", clampComputerUseObserveMaxBytes),
    screenshotMaxBytes: gov(
      "screenshotMaxBytes",
      clampComputerUseScreenshotMaxBytes,
    ),
    maxActionsPerRun: gov("maxActionsPerRun", clampComputerUseMaxActionsPerRun),
    sessionMaxMs: gov("sessionMaxMs", clampComputerUseSessionMaxMs),
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
        message: "插件注册表不可用：无法确认 Computer Use 安装状态（fail closed）。",
      };
    }
    try {
      const entries = await plugins.list();
      const entry = entries.find(
        (candidate) => candidate.id === CU_BUNDLE_ID || candidate.name === CU_BUNDLE_ID,
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
    inject: [],
    apply(ctx) {
      const service = createComputerUseService({
        executor: createUnavailableExecutor("平台执行器装配中。"),
        governance: () => resolveGovernance(ctx.env),
      });

      const gate = createBundleGate(() =>
        ctx.tryGet("plugins") as PluginsServiceLike | undefined,
      );
      const tools = ctx.get("tools");
      for (const definition of createComputerUseTools({ service, gate })) {
        tools.register(definition);
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
        .then((executor) => {
          service.setExecutor(executor);
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
        await next();
        service.releaseLease(_payload.runId);
      });

      ctx.effect(() => () => {
        void service.dispose();
      });
    },
  };
}
