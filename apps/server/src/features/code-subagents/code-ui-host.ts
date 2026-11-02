import { codeUiSubagentsListQuerySchema } from "@kenfutwork/shared";
import type { AgentSummary, AgentsListResult } from "@zcode/shared";
import type { SubagentDefinition } from "../../agent/subagent-definitions.js";
import type { CodeUiHostRpcHandler } from "../code-ui/host-rpc-handler.js";
import type { LocalInstanceService } from "../local-instance/types.js";

/**
 * 设置页「子智能体」的宿主读取面。
 *
 * 清单与真跑起来用的是同一个来源（`SUBAGENT_DEFINITIONS`，DEC-16），界面因此
 * 不会出现「写着有、跑起来没有」。本仓没有自建子智能体的存储，`capability`
 * 如实报 `userScopeAvailable: false`——界面据此收起用户作用域的写操作，
 * 而不是让用户点一下拿 501。
 */
export function createCodeUiSubagentsHost(deps: {
  localInstance: LocalInstanceService;
  definitions: () => readonly SubagentDefinition[];
}): Record<string, CodeUiHostRpcHandler> {
  return {
    "subagents.list": {
      async call(actor, args): Promise<AgentsListResult> {
        await deps.localInstance.resolve(actor);
        codeUiSubagentsListQuerySchema.parse(args[0] ?? {});
        const agents: AgentSummary[] = deps.definitions().map(
          (definition): AgentSummary => ({
            // id 保留派发名（task 的 subagent_type），name 用用户可见短名。
            id: `built-in:${definition.name}`,
            name: definition.label,
            description: definition.description,
            systemPrompt: definition.systemPrompt,
            tools: [...definition.tools, ...(definition.filesystemTools ?? [])],
            path: "",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            readOnly: definition.readOnly,
          }),
        );
        return {
          agents,
          userAgents: [],
          pluginAgents: [],
          capability: { userScopeAvailable: false },
        };
      },
    },
  };
}
