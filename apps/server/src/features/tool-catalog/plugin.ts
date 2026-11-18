import type { AgentRunExtension } from "../../agent/run-extension.js";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  createToolCatalogueMiddleware,
  type ToolActivation,
} from "./catalogue.js";

export function createToolCatalogPlugin(): PluginDefinition {
  return {
    name: "tool-catalog",
    inject: ["settings"],
    apply(ctx) {
      const activations = new Map<string, ToolActivation>();
      for (const preset of ["code", "design"] as const) {
        const extension: AgentRunExtension = {
          preset,
          createMiddleware(_identity, context) {
            if (!context) return { name: "ToolCatalogueUnavailable" };
            const handle = context.execution.scopeHandle;
            const key = JSON.stringify([
              context.execution.instanceId,
              handle?.describe().taskId ?? context.execution.threadId,
              handle?.agentId ?? "main",
              preset,
            ]);
            const activation = activations.get(key) ?? {
              generation: handle?.describe().generation ?? 0,
              names: new Set<string>(),
            };
            activations.set(key, activation);
            return createToolCatalogueMiddleware(
              context,
              activation,
              async () => {
                const actor = context.execution.actor;
                if (!actor || !context.execution.instanceId)
                  throw new Error("工具发现缺少可信 Task 用户上下文。");
                return (
                  await ctx
                    .get("settings")
                    .getInstanceSettings(actor, context.execution.instanceId)
                ).codeSearchMaxResults;
              },
            );
          },
        };
        ctx.get("capabilities").register("agent-run-extension", {
          id: `tool-catalog:${preset}`,
          value: extension,
        });
      }
      ctx.get("systemPrompt").register({
        name: "tools.discovery",
        scope: "always",
        order: 100,
        resolve: () =>
          "## 可选工具\n核心工具始终提供。需要未展示的插件或 MCP 能力时，用 ToolSearch 按用途或名称发现，再调用实际返回的工具。发现不批准执行，不能扩张目录或角色权限。",
      });
      ctx.get("capabilities").register("task-close", {
        id: "tool-catalog:activation",
        value: {
          close: (instanceId: string, taskId: string) => {
            for (const key of activations.keys()) {
              const identity = JSON.parse(key) as unknown[];
              if (identity[0] === instanceId && identity[1] === taskId)
                activations.delete(key);
            }
          },
        },
      });
    },
  };
}
