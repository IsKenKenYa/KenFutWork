import type { PluginDefinition } from "../../kernel/types.js";
import { createReadHistoryTool } from "./read-history-tool.js";
import {
  createContextHistoryArchiveBindings,
  requireContextHistoryPageBudget,
} from "./service.js";

/** Registry Consumer; runtime passes the same binding service to the native Archive Provider. */
export function createContextHistoryPlugin(): PluginDefinition {
  return {
    name: "context-history",
    inject: [],
    apply(ctx) {
      ctx.register("contextHistoryArchives", () =>
        createContextHistoryArchiveBindings(),
      );
      const archives = ctx.get("contextHistoryArchives");
      ctx.get("tools").registerDynamic({
        id: "context.ReadHistory",
        scope: "shared",
        resolve(run) {
          if (!run.scopeHandle) return null;
          if (run.scopeHandle.preset !== run.preset)
            throw new Error("历史工具工作模式与Task作用域不匹配。");
          return createReadHistoryTool(
            archives,
            requireContextHistoryPageBudget(run.scopeHandle),
          );
        },
      });
    },
  };
}
