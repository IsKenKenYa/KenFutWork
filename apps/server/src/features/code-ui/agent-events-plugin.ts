import type { AgentRunExtension } from "../../agent/run-extension.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createToolLifecycleMiddleware } from "./tool-lifecycle.js";

/** Code UI 的运行事实提供方；界面协议服务另由同域插件提供。 */
export function createCodeUiAgentEventsPlugin(): PluginDefinition {
  return {
    name: "code-ui:agent-events",
    inject: [],
    apply(ctx) {
      const extension: AgentRunExtension = {
        preset: "code",
        canonicalToolEvents: true,
        createMiddleware: createToolLifecycleMiddleware,
      };
      return ctx.get("capabilities").register("agent-run-extension", {
        id: "code-ui:canonical-events",
        value: extension,
      });
    },
  };
}
