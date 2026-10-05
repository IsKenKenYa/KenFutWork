import { registerExecutionModeRoutes } from "../../http/execution-modes.js";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  BUILTIN_EXECUTION_MODES,
  createExecutionModeService,
  evaluateToolPolicy,
} from "./execution-mode-service.js";
import { createExecutionModeStore } from "./execution-mode-store.js";

/**
 * agent-modes 插件（DEC-3，P6）：
 * - `agentModes` ctx key：激活/切换/持久化（写穿 chat_sessions.execution_mode）；
 * - 模式作为能力贡献者注册进 `ctx.capabilities`（开放贡献：新模式零改 loop）；
 * - pre-step 事件监听器：按模式给模型输入注入引导（inputDirective）；
 * - tool-pre-execute 事件监听器：solo/plan 的硬约束——内核注册表工具按线程策略拒绝。
 *   （deepagents 内置工具 write_file/execute 等的同等拦截在 deep-agent 的工具门中间件，
 *   两处共用 evaluateToolPolicy，策略来源同一 service。）
 */
export function createAgentModesPlugin(): PluginDefinition {
  return {
    name: "agent-modes",
    inject: ["localAccess", "persistence", "localInstance"],
    apply(ctx) {
      const service = createExecutionModeService({
        store: createExecutionModeStore(ctx.get("persistence")),
      });
      ctx.register("agentModes", () => service);

      for (const mode of BUILTIN_EXECUTION_MODES) {
        ctx.get("capabilities").register("execution-mode", {
          id: mode.id,
          value: { label: mode.label, description: mode.description },
        });
      }

      // pre-step：按模式给模型输入注入引导（plan 规划、solo 禁工具提示等）
      ctx.on("pre-step", async (payload, next) => {
        const mode = !payload.threadId
          ? "agent"
          : payload.preset === "code" && payload.instanceId && payload.taskId
            ? await service.hydrate(payload.threadId, {
                instanceId: payload.instanceId,
              })
            : service.getMode(payload.threadId);
        const directive = BUILTIN_EXECUTION_MODES.find(
          (m) => m.id === mode,
        )?.inputDirective;
        if (!directive || typeof payload.input !== "string") {
          return next(payload);
        }
        return next({ ...payload, input: `${directive}\n\n${payload.input}` });
      });

      // tool-pre-execute：solo 全禁、plan 只读（内核注册表路径的硬约束）
      ctx.on("tool-pre-execute", async (payload, next) => {
        // Code Task 的 V4 mode/worker ceiling 由 permissions 的可信调用事实裁决。
        if (payload.permissionInvocation) return next(payload);
        if (!payload.threadId) {
          return next(payload);
        }
        const policy = service.resolveToolPolicy(payload.threadId);
        const verdict = evaluateToolPolicy(policy, payload.toolName);
        if (verdict.allowed) {
          return next(payload);
        }
        return next({
          ...payload,
          decision: "deny",
          denyReason: verdict.reason,
        });
      });
    },
    mounted(ctx) {
      void registerExecutionModeRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        viewer: ctx.get("localInstance"),
        agentModes: ctx.get("agentModes"),
      });
    },
  };
}
