import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { createGoalService } from "../goals/service.js";
import { createCodeUiConversation } from "./conversation.js";
import { createTaskGoalHost } from "./goals.js";
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";

async function fixture() {
  const base = createGoalService();
  let verified = false;
  const goals = {
    ...base,
    verify: (...args: Parameters<typeof base.verify>) => {
      verified = true;
      return base.verify(...args);
    },
  };
  const conversation = createCodeUiConversation({
    sessionId: "task",
    workspacePath: "/project",
    config: {
      provider: "zcode",
      model: "test",
      thought: "",
      followupMode: "queue",
    },
    goals,
  });
  conversation.setGoal(
    goals.create(null, {
      goalId: "g",
      objective: "解释",
      branchGeneration: 1,
      at: 0,
    }),
  );
  conversation.startTurn({ runId: "r", commandId: "send", text: "解释" });
  const state = conversation.exportState();
  state.goalModel = {
    goalId: "g",
    selection: { providerId: "p", modelId: "test", options: {} },
    invocation: {
      providerId: "p",
      modelId: "test",
      configRevision: 1,
      body: {},
      inputCapabilities: { image: false, pdf: false },
    },
  };
  state.snapshots[0]!.rows.window.push(
    protocol.assistantTextRowSchema.parse({
      rowId: 99,
      turnId: "r",
      kind: "assistantText",
      text: "An actual explanation",
      state: "complete",
      createdAt: 0,
      createdAtSeq: 0,
    }),
  );
  const root: CodeUiSessionRecord = {
    id: "task",
    instance_id: "instance",
    project_id: "project",
    root_directory: "/project",
    additional_directories: [],
    sandbox_mode: "workspace-write",
    scope_generation: 1,
    branch_generation: 1,
    execution_state: "ready",
    chat_session_id: "task",
    root_session_id: "task",
    parent_session_id: null,
    parent_tool_call_id: null,
    state,
    revision: 0,
    active_run_id: "r",
    archived: false,
    pinned: false,
    created_at: "",
    updated_at: "",
    deleted_at: null,
  };
  const events = new Set<string>();
  const repository: Pick<CodeUiRepository, "find" | "appendEvent"> = {
    find: async () => root,
    appendEvent: async (...args) => {
      if (events.has(args[2].key)) return false;
      const decision = args[3](root);
      root.state = decision.state;
      root.active_run_id = decision.activeRunId;
      events.add(args[2].key);
      return true;
    },
  };
  // The consumer only reads this trusted handle's Task description and main role.
  const context = {
    requestModel: vi.fn(async () => ({
      text: JSON.stringify({
        passed: true,
        reason: "Independent evidence review",
      }),
      hasToolCalls: false,
      usageObserved: true,
    })),
    actor: { instanceId: "instance", accessClientId: null },
    runId: "r",
    toolCallId: "verify",
    scopeHandle: {
      agentId: "main",
      role: "main",
      describe: () => ({
        instanceId: "instance",
        projectId: "project",
        taskId: "task",
        rootDirectory: "/project",
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        generation: 1,
      }),
    },
    taskWorkContext: { branchGeneration: 1 },
  } as unknown as ToolExecutionContext;
  const host = createTaskGoalHost({
    goals,
    repository,
    refresh: async () => {},
  });
  return { host, root, context, goals, verified: () => verified };
}
const proposal = {
  revision: 2,
  evidenceIds: ["row:99"],
  passed: true,
  reason: "The explanation answers the requested question",
};
it("独立评估消费冻结模型与真实证据，执行模型只提出完成申请", async () => {
  const { host, context, verified } = await fixture();
  const view = await host.read(context);
  expect(view?.evidenceCandidates).toContainEqual({
    id: "row:99",
    kind: "assistantText",
    revision: 2,
  });
  expect(JSON.stringify(view)).not.toContain("An actual explanation");
  const result = await host.verify(context, proposal);
  expect(verified()).toBe(true);
  expect(result.status).toBe("complete");
  expect(result.verification?.reason).toBe("Independent evidence review");
  expect(context.requestModel).toHaveBeenCalledWith(
    expect.objectContaining({
      invocation: expect.objectContaining({ configRevision: 1 }),
      input: expect.stringContaining("An actual explanation"),
    }),
  );
  await host.verify(context, proposal);
  expect(context.requestModel).toHaveBeenCalledTimes(1);
});

it("执行模型报完成但独立评估不通过时保持未完成", async () => {
  const { host, context } = await fixture();
  context.requestModel = async () => ({
    text: '{"passed":false,"reason":"Missing requirements"}',
    hasToolCalls: false,
    usageObserved: true,
  });
  expect((await host.verify(context, proposal)).status).toBe("notSatisfied");
});

it.each([
  "invalid",
  "invalidShape",
  "extra",
  "tool",
  "usage",
  "network",
  "port",
  "model",
])("%s评估故障保留目标进度并暂停，不能变为完成", async (failure) => {
  const { host, context, root } = await fixture();
  if (failure === "port") context.requestModel = undefined;
  else
    context.requestModel = async () => {
      if (failure === "network") throw new Error("upstream unavailable");
      return {
        text:
          failure === "invalid"
            ? "passed"
            : failure === "invalidShape"
              ? '{"passed":"true","reason":"Review"}'
              : failure === "extra"
                ? '{"passed":true,"reason":"Review","complete":true}'
                : '{"passed":true,"reason":"Review"}',
        hasToolCalls: failure === "tool",
        usageObserved: failure !== "usage",
      };
    };
  if (failure === "model") root.state!.goalModel = null;
  const result = await host.verify(context, proposal);
  expect(result.status).toBe("paused");
  expect(result.objective).toBe("解释");
  expect(result.claimedRunId).toBe("r");
  expect(result.verification).toBeNull();
  expect(root.state!.goalRecord!.evaluation).toBeNull();
});

it.each(["pause", "run", "scope", "branch"])(
  "%s变化后的迟到独立评估不能完成Goal",
  async (change) => {
    const { host, context, root, goals } = await fixture();
    context.requestModel = async () => {
      if (change === "pause") {
        const goal = root.state!.goalRecord!;
        root.state!.goalRecord = goals.pause(goal, {
          goalId: goal.goalId,
          revision: goal.revision,
          reason: "user.pause",
          at: 1,
        });
      }
      if (change === "run") root.active_run_id = "new";
      if (change === "scope") root.scope_generation = 2;
      if (change === "branch") root.branch_generation = 2;
      return {
        text: '{"passed":true,"reason":"Review"}',
        hasToolCalls: false,
        usageObserved: true,
      };
    };
    await expect(host.verify(context, proposal)).rejects.toThrow(
      "旧结果不再生效",
    );
    expect(root.state!.goalRecord!.status).not.toBe("complete");
  },
);
