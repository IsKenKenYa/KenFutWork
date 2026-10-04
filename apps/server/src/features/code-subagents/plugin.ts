import type { PluginDefinition } from "../../kernel/types.js";
import { createCodeChildHarness } from "./harness.js";
import { createCodeSubagentTool } from "./task-tool.js";

/** Code角色属于同一运行能力的工具贡献，无第二个Agent runtime。 */
export function createCodeSubagentsPlugin(): PluginDefinition {
  return {
    name: "code-subagents",
    inject: ["settings", "taskWork"],
    apply(ctx) {
      let task: ReturnType<typeof createCodeSubagentTool> | undefined;
      ctx.get("tools").registerDynamic({
        id: "code.subagents.Task",
        scope: "code",
        resolve(run) {
          if (!run.scopeHandle) return null;
          if (task) return task;
          task = createCodeSubagentTool({
            manager: ctx.get("taskWork"),
            limitsFor: async (context) => {
              if (!context.actor)
                throw new Error("子任务治理设置缺少可信用户身份。");
              const settings = await ctx
                .get("settings")
                .getWorkspaceSettings(context.actor, context.scope.workspaceId);
              return {
                maxDepth: settings.subagentMaxDepth,
                previewMaxChars: settings.processPreviewMaxChars,
              };
            },
            runChild: (request, signal) =>
              createCodeChildHarness({
                runs: ctx.get("agentRuns"),
                metadata: ctx.get("agentRunMetadata"),
                sessions: {
                  open: (input) => ctx.get("codeUi").openChildSession(input),
                },
              })(request, signal),
          });
          return task;
        },
      });
      ctx.get("systemPrompt").register({
        name: "code.subagents",
        scope: "code",
        order: 110,
        resolve: () =>
          "## 子任务\nTask派发explore/review/worker到独立会话。明确ownership与完成标准，子正文与父转录分开；worker继承派发时权限上限。前台子任务随父Run停止；显式后台子任务归Task，结束后自动通知。TaskOutput读取状态和完整结果，TaskStop等待真实停止。",
      });
    },
  };
}
