import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { SUBAGENT_DEFINITIONS } from "../../agent/subagent-definitions.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { CODE_UI_HOST_RPC_CAPABILITY } from "../code-ui/host-rpc-handler.js";
import {
  SUBAGENT_USAGE_CAPABILITY,
  type SubagentUsageLookup,
} from "../task-work/types.js";
import { createCodeUiSubagentsHost } from "./code-ui-host.js";
import { createCodeChildHarness } from "./harness.js";
import { readInstanceInstructions } from "./instance-instructions.js";
import { createCodeSubagentTool } from "./task-tool.js";
import {
  findUserAgentByName,
  listUserAgents,
  readUserAgentState,
  userAgentsDirectory,
  workspaceAgentsDirectory,
} from "./user-agent-store.js";

const BUILT_IN_ROLES = new Set(["explore", "review", "worker"]);
/** 自定义智能体声明了写入/执行工具才算可写；纯读工具按只读作用域派发。 */
const WRITE_TOOLS = new Set(["Write", "Edit", "ApplyPatch", "Bash"]);

function customAgentRole(agent: {
  permissionMode?: string;
  tools?: readonly string[];
}): "explore" | "worker" {
  if (agent.permissionMode === "plan") return "explore";
  if (agent.tools && !agent.tools.some((tool) => WRITE_TOOLS.has(tool)))
    return "explore";
  return "worker";
}

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
            resolveTarget: async ({ actor, name, handle }) => {
              const owner = await ctx.get("localInstance").resolve(actor);
              if (BUILT_IN_ROLES.has(name)) {
                const state = await readUserAgentState(owner.dataDir);
                const selection = state.builtInModelSelectionOverrides[name];
                return {
                  role: name as "explore" | "review" | "worker",
                  label: name,
                  ...(selection ? { modelSelection: selection } : {}),
                };
              }
              const workspaceAgent = await findUserAgentByName({
                dataDir: owner.dataDir,
                directory: workspaceAgentsDirectory(
                  handle.describe().rootDirectory,
                ),
                scope: "workspace",
                name,
                enabledOnly: true,
              });
              const agent =
                workspaceAgent ??
                (await findUserAgentByName({
                  dataDir: owner.dataDir,
                  directory: userAgentsDirectory(owner.dataDir),
                  scope: "user",
                  name,
                  enabledOnly: true,
                }));
              if (!agent) return null;
              return {
                role: customAgentRole(agent),
                label: agent.name,
                systemPrompt: agent.systemPrompt,
                ...(agent.tools ? { toolAllowlist: agent.tools } : {}),
                ...(agent.disallowedTools
                  ? { disallowedTools: agent.disallowedTools }
                  : {}),
                ...(agent.modelSelection
                  ? { modelSelection: agent.modelSelection }
                  : {}),
                ...(agent.injectAgentsMd !== undefined
                  ? { injectAgentsMd: agent.injectAgentsMd }
                  : {}),
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
      // 实例级默认指令（AGENTS.md）：所有智能体（含子智能体）每轮都注入。
      ctx.get("systemPrompt").register({
        name: "code.instance-instructions",
        scope: "always",
        order: 90,
        async resolve(context) {
          if (context.omitInstanceInstructions) return null;
          const actor = context.execution?.actor;
          if (!actor) return null;
          const owner = await ctx.get("localInstance").resolve(actor);
          const settings = await ctx
            .get("settings")
            .getInstanceSettings(actor, owner.instanceId)
            .catch(() => null);
          const content = await readInstanceInstructions(
            owner.dataDir,
            settings?.codeReadMaxBytes ??
              AGENT_GOVERNANCE_DEFAULTS.codeReadMaxBytes,
          );
          return content ? `## 默认指令（AGENTS.md）\n\n${content}` : null;
        },
      });
      // 用户/工作区智能体清单：模型据此知道 Task 可派发的名称。
      ctx.get("systemPrompt").register({
        name: "code.user-subagents",
        scope: "always",
        order: 111,
        async resolve(context) {
          const actor = context.execution?.actor;
          if (!actor) return null;
          const owner = await ctx.get("localInstance").resolve(actor);
          const user = await listUserAgents(
            owner.dataDir,
            "user",
            userAgentsDirectory(owner.dataDir),
          );
          const workspacePath = context.executionScope?.rootDirectory;
          const workspace = workspacePath
            ? await listUserAgents(
                owner.dataDir,
                "workspace",
                workspaceAgentsDirectory(workspacePath),
              )
            : null;
          const disabled = new Set([
            ...user.state.disabledAgentIds,
            ...(workspace?.state.disabledAgentIds ?? []),
          ]);
          const byName = new Map<
            string,
            { name: string; description: string }
          >();
          for (const agent of [...user.agents, ...(workspace?.agents ?? [])]) {
            if (disabled.has(agent.id)) continue;
            // 同名时工作区覆盖用户级，与派发解析顺序一致。
            byName.set(agent.name.toLowerCase(), agent);
          }
          if (byName.size === 0) return null;
          const lines = [...byName.values()].map(
            (agent) => `- ${agent.name}：${agent.description}`,
          );
          return `## 用户智能体\nTask 的 subagent_type 可填以下名称：\n${lines.join("\n")}`;
        },
      });
    },
    mounted(ctx) {
      // 设置页「智能体」的读写面：与派发共用同一份 Markdown 存储。
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
