import { registerExecutionModeRoutes } from "../../http/execution-modes.js";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  BUILTIN_EXECUTION_MODES,
  createExecutionModeService,
} from "./execution-mode-service.js";

/**
 * agent-modes 插件（DEC-3，P6）：
 * - `agentModes` ctx key：激活/切换/持久化；
 * - 模式作为能力贡献者注册进 `ctx.capabilities`（开放贡献：新模式零改 loop）；
 * - pre-step 事件监听器：plan 模式给模型输入注入规划引导（inputDirective）。
 */
export function createAgentModesPlugin(): PluginDefinition {
  return {
    name: "agent-modes",
    inject: ["auth"],
    apply(ctx) {
      const service = createExecutionModeService();
      ctx.register("agentModes", () => service);

      for (const mode of BUILTIN_EXECUTION_MODES) {
        ctx.get("capabilities").register("execution-mode", {
          id: mode.id,
          value: { label: mode.label, description: mode.description },
        });
      }

      // plan 模式：pre-step waterfall 注入规划引导（先规划待批准再执行）
      ctx.on("pre-step", async (payload, next) => {
        const mode = payload.threadId
          ? service.getMode(payload.threadId)
          : "agent";
        const directive = BUILTIN_EXECUTION_MODES.find(
          (m) => m.id === mode,
        )?.inputDirective;
        if (!directive || typeof payload.input !== "string") {
          return next(payload);
        }
        return next({ ...payload, input: `${directive}\n\n${payload.input}` });
      });
    },
    mounted(ctx) {
      void registerExecutionModeRoutes(ctx.app, {
        auth: ctx.get("auth"),
        agentModes: ctx.get("agentModes"),
      });
    },
  };
}
