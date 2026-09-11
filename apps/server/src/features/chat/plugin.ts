import { registerChatRoutes } from "../../http/chat.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createChatService } from "./chat-service.js";
import { createThreadService } from "./thread-service.js";

/**
 * chat 插件：threads + chat 两个领域 key（§4.2「领域服务先于 chat」）。
 * routes 只消费 chat；threadService 另被 ws/runs 消费，故单独成 key。
 */
export function createChatPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): PluginDefinition {
  return {
    name: "chat",
    inject: ["auth"],
    apply(ctx) {
      ctx.register("threads", () =>
        createThreadService({ createUserClient: deps.createUserClient }),
      );
      ctx.register("chat", (d) =>
        createChatService({
          createUserClient: deps.createUserClient,
          threadService: d.get("threads"),
        }),
      );
    },
    mounted(ctx) {
      void registerChatRoutes(ctx.app, {
        auth: ctx.get("auth"),
        chatService: ctx.get("chat"),
      });
    },
  };
}
