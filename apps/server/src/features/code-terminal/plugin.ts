import type { PluginDefinition } from "../../kernel/types.js";
import { createCodeTerminalService } from "./service.js";

/** 人类PTY与模型命令共用ProcessSandbox，但连接关闭责任归终端模块。 */
export function createCodeTerminalPlugin(): PluginDefinition {
  return {
    name: "code-terminal",
    inject: ["executionScopes", "processSandbox", "viewer", "settings"],
    apply(ctx) {
      ctx.register("codeTerminal", () => createCodeTerminalService({
        scopes: ctx.get("executionScopes"), sandbox: ctx.get("processSandbox"),
        viewer: ctx.get("viewer"), settings: ctx.get("settings"),
      }));
    },
    mounted(ctx) {
      const terminals = ctx.get("codeTerminal");
      ctx.get("capabilities").register("task-before-process-close", {
        id: "code-terminal:connections",
        value: { close: (workspaceId: string, taskId: string) => terminals.closeTask(workspaceId, taskId, "Task已关闭") },
      });
      ctx.app.addHook("onClose", () => terminals.close("终端宿主关闭"));
    },
  };
}
