import type { AgentsListResult } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  SUBAGENT_DEFINITIONS,
  type SubagentDefinition,
} from "../../agent/subagent-definitions.js";
import { createCodeUiSubagentsHost } from "./code-ui-host.js";

const actor = { instanceId: "instance-1", accessClientId: null };
const localInstance = {
  resolve: async () => ({ instanceId: "instance-1" }),
} as never;

const handlers = createCodeUiSubagentsHost({
  localInstance,
  definitions: () => SUBAGENT_DEFINITIONS as readonly SubagentDefinition[],
});

function list(args: unknown[] = []): Promise<AgentsListResult> {
  const handler = handlers["subagents.list"];
  if (!handler) throw new Error("subagents.list 未贡献");
  return handler.call(actor, args) as Promise<AgentsListResult>;
}

describe("设置页子智能体读取面", () => {
  it("清单与派发用的定义注册表一一对应", async () => {
    const result = await list([
      { workspacePath: "", mode: "allRuntimeScopes" },
    ]);
    expect(result.agents.map((agent) => agent.id)).toEqual(
      SUBAGENT_DEFINITIONS.map((definition) => `built-in:${definition.name}`),
    );
    const first = result.agents[0];
    const definition = SUBAGENT_DEFINITIONS[0];
    if (!first || !definition) throw new Error("夹具缺少子代理定义");
    // 界面显示用户可见短名，派发名留在 id 里
    expect(first.name).toBe(definition.label);
    expect(first.description).toBe(definition.description);
    expect(first.systemPrompt).toBe(definition.systemPrompt);
    expect(first.tools).toEqual([
      ...definition.tools,
      ...(definition.filesystemTools ?? []),
    ]);
    expect(first.scope).toBe("built-in");
    expect(first.source).toBe("built-in");
    expect(first.readOnly).toBe(definition.readOnly);
  });

  it("没有自建存储就如实报用户作用域不可用，界面据此收起写操作", async () => {
    const result = await list();
    expect(result.capability.userScopeAvailable).toBe(false);
    expect(result.userAgents).toEqual([]);
    expect(result.pluginAgents).toEqual([]);
  });

  it("设置页用户分段模式（settingsUserOnly）同样可读，不抛未接通", async () => {
    const result = await list([
      { workspacePath: "", mode: "settingsUserOnly" },
    ]);
    expect(result.agents.length).toBeGreaterThan(0);
  });

  it("拒绝未知 mode，避免把拼错的查询当成全量清单", async () => {
    await expect(list([{ mode: "everything" }])).rejects.toThrow();
  });
});
