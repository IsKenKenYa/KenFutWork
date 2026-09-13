import { registerChatRoutes } from "../../http/chat.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createProjectRepository } from "../projects/repository.js";
import { createChatService } from "./chat-service.js";
import { createChatRepository } from "./repository.js";
import { createThreadService } from "./thread-service.js";

/**
 * chat 插件：threads + chat 两个领域 key（§4.2「领域服务先于 chat」）。
 * routes 只消费 chat；threadService 另被 ws/runs 消费，故单独成 key。
 * 数据访问经 `persistence` 缝（会话/消息无 workspace_id 列，经画布→项目链限定）。
 */
export function createChatPlugin(): PluginDefinition {
  return {
    name: "chat",
    inject: ["auth", "persistence", "viewer"],
    apply(ctx) {
      const repository = createChatRepository(ctx.get("persistence"));
      // Code 模式会话载体（隐藏「Code 工作台」项目 + 主画布）由 projects 聚合供给
      const codeWorkbench = createProjectRepository(ctx.get("persistence"));

      ctx.register("threads", () =>
        createThreadService({
          repository,
          viewerService: ctx.get("viewer"),
        }),
      );
      ctx.register("chat", (d) =>
        createChatService({
          codeWorkbench,
          repository,
          threadService: d.get("threads"),
          viewerService: ctx.get("viewer"),
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
