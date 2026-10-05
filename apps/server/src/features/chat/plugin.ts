import { registerChatRoutes } from "../../http/chat.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createChatService } from "./chat-service.js";
import { createChatRepository } from "./repository.js";
import { createThreadService } from "./thread-service.js";

/**
 * chat 插件：threads + chat 两个领域 key（§4.2「领域服务先于 chat」）。
 * routes 只消费 chat；threadService 另被 ws/runs 消费，故单独成 key。
 * 数据访问经 `persistence` 缝（会话持有 instance/project；消息经会话→项目链限定）。
 */
export function createChatPlugin(): PluginDefinition {
  return {
    name: "chat",
    inject: ["localAccess", "persistence", "localInstance"],
    apply(ctx) {
      const repository = createChatRepository(ctx.get("persistence"));

      ctx.register("threads", () =>
        createThreadService({
          repository,
          localInstance: ctx.get("localInstance"),
        }),
      );
      ctx.register("chat", (d) =>
        createChatService({
          repository,
          threadService: d.get("threads"),
          localInstance: ctx.get("localInstance"),
        }),
      );
    },
    mounted(ctx) {
      void registerChatRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        chatService: ctx.get("chat"),
      });
    },
  };
}
