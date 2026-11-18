import { instanceSettingsSchema } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createTaskMcpService } from "../mcp/task-mcp-service.js";
import { createTaskMcpTools } from "../mcp/task-mcp-tools.js";
import { stdioSandbox } from "../mcp/test-stdio-process.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createGoalServiceFixture } from "./goal-service.fixture.js";

type Fixture = Awaited<ReturnType<typeof createGoalServiceFixture>>;
async function goalMcp(f: Fixture) {
  const permissions = createPermissionService();
  const events = new AgentRunEventBus();
  events.on("tool-pre-execute", async (event, next) =>
    event.permissionInvocation
      ? next({
          ...event,
          decision: (await permissions.admit(event.permissionInvocation))
            .decision,
        })
      : next(event),
  );
  const registry = new ToolRegistryImpl(events, () => permissions);
  const scopes = createExecutionScopes({
    repository: createScopeRepository(f.database.persistence),
    localInstance: f.database.localInstance,
  });
  const handle = await scopes.openTask(f.actor, f.scope.taskId);
  const process = stdioSandbox();
  const mcp = createTaskMcpService({
    sandbox: process.sandbox,
    registry,
    version: "fixture",
    settings: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({ defaultModel: "test" }),
    },
  });
  for (const tool of createTaskMcpTools(mcp)) registry.register(tool);
  const host = f.host(
    "goal-current-capabilities",
    registry.captureContributions.bind(registry),
  );
  const humanAnswers: string[] = [];
  permissions.onEvent(async (event) => {
    await host.onApprovalEvent(event);
    if (event.type === "requested") {
      humanAnswers.push(event.identity.toolCallId);
      await permissions.resolve({
        interactionId: event.interaction.interactionId,
        binding: event.identity,
        answer: { optionId: "allowOnce" },
      });
    }
  });
  const context = (
    index: number,
    toolCallId: string,
  ): ToolExecutionContext => ({
    actor: f.actor,
    instanceId: f.scope.instanceId,
    scopeHandle: handle,
    runId: f.runs[index]!.runId,
    toolCallId,
    workContext: { preset: "code" },
    frozenContributions: f.runs[index]!.frozenContributions,
    taskWorkContext: {
      actor: f.actor,
      scope: handle.describe(),
      agentId: "main",
      runId: f.runs[index]!.runId,
      branchGeneration: 1,
    },
    codeApproval: {
      ceiling: "build",
      resolve: async () => ({
        mode: "build",
        scopeGeneration: handle.describe().generation,
        branchGeneration: 1,
      }),
    },
  });
  const resolved = (index: number) =>
    registry.resolveRunTools({
      preset: "code",
      scopeHandle: handle,
      frozenContributions: f.runs[index]!.frozenContributions,
      backendFactory: () => handle.backend,
    });
  return { registry, host, context, resolved, handle, mcp, humanAnswers };
}

// 模型执行器/进程句柄受控替身；PG、原RPC、TaskScope、Kernel审批和MCP SDK是真实接线。
describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "Goal逐Run能力接纳 integration",
  () => {
    it("审批安装Task MCP后下一自动GoalRun可发现并调用；旧Run不扩权，修改配置后显式恢复冻结新能力且模型保留", async () => {
      const f = await createGoalServiceFixture();
      let setup: Awaited<ReturnType<typeof goalMcp>> | undefined;
      try {
        setup = await goalMcp(f);
        const command = await f.connect(setup.host);
        await command("sendGoalCommand", { text: "安装并使用本Task的MCP" });
        await f.waitRuns(1);
        const initial = structuredClone(f.runs[0]!.frozenContributions);
        expect(initial?.entries.length).toBeGreaterThan(0);
        const installer = setup.registry.require("install_mcp_server");
        await setup.registry.executeDefinition(
          installer,
          {
            name: "goal-tool",
            command: "node",
            env: { TASK_TOKEN: "first-config" },
          },
          setup.context(0, "install-once"),
        );
        expect(setup.humanAnswers).toContain("install-once");
        expect(
          setup.resolved(0).some((tool) => tool.name.startsWith("mcp__task_")),
        ).toBe(false);
        await f.finish(0);
        await f.waitRuns(2);
        const imported = setup
          .resolved(1)
          .find((tool) => tool.name.startsWith("mcp__task_"));
        if (!imported) throw new Error("下一GoalRun没有接纳已安装MCP");
        expect(
          await setup.registry.executeDefinition(
            imported,
            { text: "真实MCP结果" },
            setup.context(1, "invoke-once"),
          ),
        ).toMatchObject({ content: [{ text: "真实MCP结果" }] });
        expect(setup.humanAnswers).toContain("invoke-once");
        expect(f.runs[0]!.frozenContributions).toEqual(initial);
        expect(f.runs[1]!.modelInvocation).toEqual(f.runs[0]!.modelInvocation);
        const readonly = {
          ...setup.context(1, "readonly-denied"),
          scopeHandle: setup.handle.derive("explore", "reader"),
        };
        await expect(
          setup.registry.executeDefinition(
            imported,
            { text: "禁止扩权" },
            readonly,
          ),
        ).rejects.toThrow();
        expect(setup.humanAnswers).not.toContain("readonly-denied");
        await setup.registry.executeDefinition(
          setup.registry.require("uninstall_mcp_server"),
          { name: "goal-tool" },
          setup.context(1, "uninstall-once"),
        );
        await setup.registry.executeDefinition(
          installer,
          {
            name: "goal-tool",
            command: "node",
            env: { TASK_TOKEN: "changed-config" },
          },
          setup.context(1, "install-new-config"),
        );
        expect(
          setup.resolved(1).some((tool) => tool.name.startsWith("mcp__task_")),
        ).toBe(false);
        await expect(
          setup.registry.executeDefinition(
            imported,
            { text: "旧定义" },
            setup.context(1, "stale-denied"),
          ),
        ).rejects.toThrow();
        await (await command("pauseGoal", {})).settled;
        await (await command("resumeGoal", {})).settled;
        await f.waitRuns(3);
        expect(
          setup.resolved(2).some((tool) => tool.name.startsWith("mcp__task_")),
        ).toBe(true);
        expect(f.runs[2]!.frozenContributions).not.toEqual(
          f.runs[1]!.frozenContributions,
        );
        expect(f.runs[2]!.modelInvocation).toEqual(f.runs[0]!.modelInvocation);
        const state = (await f.repository.find(
          f.scope.instanceId,
          f.scope.taskId,
        ))!.state!;
        expect(state.goalModel).not.toHaveProperty("frozenContributions");
        expect(JSON.stringify(state)).not.toContain("first-config");
        expect(JSON.stringify(state)).not.toContain("changed-config");
        await (await command("pauseGoal", {})).settled;
      } finally {
        await setup?.mcp.shutdown("Goal回归结束");
        await f.close();
      }
    });
  },
);
