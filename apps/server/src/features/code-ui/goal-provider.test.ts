import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { createGoalService } from "../goals/service.js";
import { createCodeUiConversation } from "./conversation.js";
import { createTaskGoalHost } from "./goals.js";
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";

it("真实Task Goal Host公开验证seam委托替换Provider，候选只返回行身份", async () => {
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
  const repository: Pick<CodeUiRepository, "find" | "appendEvent"> = {
    find: async () => root,
    appendEvent: async (...args) => {
      const decision = args[3](root);
      root.state = decision.state;
      root.active_run_id = decision.activeRunId;
      return true;
    },
  };
  // The consumer only reads this trusted handle's Task description and main role.
  const context = {
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
  const view = await host.read(context);
  expect(view?.evidenceCandidates).toContainEqual({
    id: "row:99",
    kind: "assistantText",
    revision: 2,
  });
  expect(JSON.stringify(view)).not.toContain("An actual explanation");
  const result = await host.verify(context, {
    revision: 2,
    evidenceIds: ["row:99"],
    passed: true,
    reason: "The explanation answers the requested question",
  });
  expect(verified).toBe(true);
  expect(result.status).toBe("complete");
});
