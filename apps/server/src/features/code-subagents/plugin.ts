import { SUBAGENT_DEFINITIONS } from "../../agent/subagent-definitions.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { CODE_UI_HOST_RPC_CAPABILITY } from "../code-ui/host-rpc-handler.js";
import {
  SUBAGENT_USAGE_CAPABILITY,
  type SubagentUsageLookup,
} from "../task-work/types.js";
import { createCodeUiSubagentsHost } from "./code-ui-host.js";
import { createCodeChildHarness } from "./harness.js";
import { createCodeSubagentTool } from "./task-tool.js";

/** Code角色属于同一运行能力的工具贡献，无第二个Agent runtime。 */
export function createCodeSubagentsPlugin(): PluginDefinition {
  return {
    name: "code-subagents",
    inject: ["settings", "taskWork", "localInstance", "usage"],
    apply(ctx) {
      let task: ReturnType<typeof createCodeSubagentTool> | undefined;
      ctx.get("tools").registerDynamic({
        id: "code.subagents.Task",
        scope: "shared",
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
                .getInstanceSettings(context.actor, context.scope.instanceId);
              return {
                maxDepth: settings.subagentMaxDepth,
                previewMaxChars: settings.processPreviewMaxChars,
              };
            },
            usageFor: async (context, childRunId) => {
              if (!context.actor) return null;
              return ctx
                .get("usage")
                .runSummary(context.scope.instanceId, childRunId);
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
        scope: "always",
        order: 110,
        resolve: () =>
          "## 子任务\nTask派发explore/review/worker到独立会话。明确ownership与完成标准，子正文与父转录分开；worker继承派发时权限上限。前台子任务随父Run停止；显式后台子任务归Task，结束后自动通知。TaskOutput读取状态和完整结果，TaskStop等待真实停止。",
      });
      // 子代理用量归因：Task 前台完成与 TaskOutput 后台读取都从同一处查。
      ctx.effect(() =>
        ctx.get("capabilities").register(SUBAGENT_USAGE_CAPABILITY, {
          id: "code-subagents:usage",
          value: {
            summarize: (instanceId, childSessionId) =>
              ctx.get("usage").runSummaryBySession(instanceId, childSessionId),
          } satisfies SubagentUsageLookup,
        }),
      );
    },
    mounted(ctx) {
      // 设置页「子智能体」的读取面：与派发共用同一份定义注册表。
      for (const [id, value] of Object.entries(
        createCodeUiSubagentsHost({
          localInstance: ctx.get("localInstance"),
          definitions: () => SUBAGENT_DEFINITIONS,
        }),
      )) {
        ctx.effect(() =>
          ctx
            .get("capabilities")
            .register(CODE_UI_HOST_RPC_CAPABILITY, { id, value }),
        );
      }
    },
  };
}
