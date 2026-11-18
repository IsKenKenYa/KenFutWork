import { registerRunTimelineRoutes } from "../../http/run-timeline.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createRunTimelineRepository } from "./repository.js";
import { createRunTimelineService } from "./service.js";
import type { RunTimelineService } from "./types.js";

/**
 * 单轮运行时间线插件：读事件日志、运行终态与用量表，提供回看与 Markdown 导出。
 * 只读投影，不写任何表；事件日志的唯一写方仍是 code-ui 会话。
 */
export function createRunTimelinePlugin(): PluginDefinition {
  let timeline: RunTimelineService | undefined;
  return {
    name: "run-timeline",
    inject: ["localAccess", "persistence", "settings"],
    apply(ctx) {
      timeline = createRunTimelineService({
        repository: createRunTimelineRepository(ctx.get("persistence")),
      });
    },
    mounted(ctx) {
      if (!timeline) return;
      void registerRunTimelineRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        settings: ctx.get("settings"),
        timeline,
      });
    },
  };
}
