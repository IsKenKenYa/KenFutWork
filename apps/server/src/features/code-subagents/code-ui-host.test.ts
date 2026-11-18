import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentsListResult } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUBAGENT_DEFINITIONS,
  type SubagentDefinition,
} from "../../agent/subagent-definitions.js";
import type { CodeUiHostRpcContext } from "../code-ui/host-rpc-handler.js";
import { createCodeUiSubagentsHost } from "./code-ui-host.js";
import { userAgentsDirectory } from "./user-agent-store.js";

const actor = { instanceId: "instance-1", accessClientId: null };

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kfw-subagents-host-"));
});

const context: CodeUiHostRpcContext = {
  actor,
  connectionId: "test-connection",
  signal: new AbortController().signal,
  requireInitialized: () => {},
  onClose: () => () => {},
};

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function createHandlers() {
  return createCodeUiSubagentsHost({
    localInstance: {
      resolve: async () => ({ instanceId: "instance-1", dataDir }),
    } as never,
    definitions: () => SUBAGENT_DEFINITIONS as readonly SubagentDefinition[],
  });
}

function list(
  args: unknown[] = [],
  handlers = createHandlers(),
): Promise<AgentsListResult> {
  const handler = handlers["subagents.list"];
  if (!handler) throw new Error("subagents.list 未贡献");
  return handler.call(actor, args, context) as Promise<AgentsListResult>;
}

const config = {
  name: "doc-reviewer",
  description: "审阅文档",
  systemPrompt: "你是文档审阅员。",
  tools: ["Read", "Grep"],
};

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

  it("本机实例支持用户作用域，并上报默认 AGENTS.md 路径", async () => {
    const result = await list();
    expect(result.capability.userScopeAvailable).toBe(true);
    expect(result.userAgents).toEqual([]);
    expect(result.pluginAgents).toEqual([]);
    expect(result.defaultInstructionsPath).toBe(join(dataDir, "AGENTS.md"));
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

  it("创建、编辑、启停与删除用户智能体走同一份存储", async () => {
    const handlers = createHandlers();
    const create = handlers["subagents.createAgent"];
    const update = handlers["subagents.updateAgent"];
    const toggle = handlers["subagents.setEnabled"];
    const remove = handlers["subagents.deleteAgent"];
    if (!create || !update || !toggle || !remove)
      throw new Error("智能体写接口未贡献");

    const created = (await create.call(
      actor,
      [{ config, provider: "glm", scope: "user" }],
      context,
    )) as { agent: { id: string; name: string; path: string } };
    expect(created.agent.id).toBe("user:user:doc-reviewer");
    expect(created.agent.path).toBe(
      join(userAgentsDirectory(dataDir), "doc-reviewer.md"),
    );

    const listed = await list();
    expect(listed.userAgents).toEqual([
      expect.objectContaining({
        id: created.agent.id,
        name: "doc-reviewer",
        enabled: true,
      }),
    ]);

    await toggle.call(
      actor,
      [{ agentId: created.agent.id, enabled: false }],
      context,
    );
    expect((await list()).userAgents[0]?.enabled).toBe(false);

    await update.call(
      actor,
      [
        {
          agentId: created.agent.id,
          config: { ...config, name: "doc-reviewer-2", description: "改过" },
          provider: "glm",
          scope: "user",
        },
      ],
      context,
    );
    const renamed = await list();
    expect(renamed.userAgents.map((agent) => agent.name)).toEqual([
      "doc-reviewer-2",
    ]);

    await remove.call(
      actor,
      [{ agentId: "user:user:doc-reviewer-2", filePath: "" }],
      context,
    );
    expect((await list()).userAgents).toEqual([]);
  });

  it("工作区智能体按项目目录读写，不污染用户作用域", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kfw-workspace-agents-"));
    try {
      const handlers = createHandlers();
      const create = handlers["subagents.createAgent"];
      if (!create) throw new Error("智能体写接口未贡献");
      const created = (await create.call(
        actor,
        [
          {
            config,
            provider: "glm",
            scope: "workspace",
            workspacePath: workspace,
          },
        ],
        context,
      )) as { agent: { path: string } };
      expect(created.agent.path).toBe(
        join(workspace, ".zcode", "agents", "doc-reviewer.md"),
      );
      const listed = await list([
        { workspacePath: workspace, mode: "allRuntimeScopes" },
      ]);
      expect(listed.userAgents).toEqual([]);
      expect(
        listed.agents.filter((agent) => agent.scope === "workspace"),
      ).toHaveLength(1);
      const userOnly = await list([
        { workspacePath: workspace, mode: "settingsUserOnly" },
      ]);
      expect(
        userOnly.agents.filter((agent) => agent.scope === "workspace"),
      ).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
