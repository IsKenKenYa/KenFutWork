import websocket from "@fastify/websocket";
import type { PluginDefinition } from "../../kernel/types.js";
import { registerWsRoute } from "../../ws/handler.js";

/** 共享传输由插件装配；Code 的工作域消费者不会向 app.ts 添加专属依赖。 */
export function createRealtimePlugin(): PluginDefinition {
  return {
    name: "chat:realtime",
    inject: ["ws", "agentRuns", "agentModes", "agentRunMetadata", "auth", "chat", "codeTerminal", "codeUi", "executionScopes", "settings", "threads", "viewer"],
    apply() {},
    mounted(ctx) {
      void ctx.app.register(async (instance) => {
        await instance.register(websocket);
        const { connectionManager, eventBuffer } = ctx.get("ws");
        await registerWsRoute(instance, {
          agentRuns: ctx.get("agentRuns"), agentModes: ctx.get("agentModes"),
          agentRunMetadataService: ctx.get("agentRunMetadata"), auth: ctx.get("auth"),
          chatService: ctx.get("chat"), codeTerminal: ctx.get("codeTerminal"),
          executionScopes: ctx.get("executionScopes"), connectionManager, eventBuffer,
          codeUi: ctx.get("codeUi"),
          settingsService: ctx.get("settings"), threadService: ctx.get("threads"), viewerService: ctx.get("viewer"),
        });
      });
    },
  };
}
