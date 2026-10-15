import { mkdtemp, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { afterEach, expect, it, vi } from "vitest";
import {
  createRuntimeTestInstance,
  RUNTIME_TEST_ACTOR,
} from "../../agent/runtime-test-fixtures.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { fileDiffDisplay } from "../code-tools/file-display.js";
import {
  createExecutionScopes,
  type ExecutionScopeHandle,
} from "../execution/scope-service.js";
import { createGoalService } from "../goals/service.js";
import { createCodeUiConversation } from "./conversation.js";
import { createTaskGoalHost } from "./goals.js";
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";

async function fixture(handle?: ExecutionScopeHandle) {
  const scope = handle?.describe() ?? {
    instanceId: "instance",
    projectId: "project",
    taskId: "task",
    rootDirectory: "/project",
    additionalDirectories: [],
    sandboxMode: "workspace-write" as const,
    generation: 1,
  };
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
    sessionId: scope.taskId,
    workspacePath: scope.rootDirectory,
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
    id: scope.taskId,
    instance_id: scope.instanceId,
    project_id: scope.projectId,
    root_directory: scope.rootDirectory,
    additional_directories: [],
    sandbox_mode: "workspace-write",
    scope_generation: 1,
    branch_generation: 1,
    execution_state: "ready",
    chat_session_id: scope.taskId,
    root_session_id: scope.taskId,
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
    actor: { instanceId: scope.instanceId, accessClientId: null },
    runId: "r",
    toolCallId: "verify",
    scopeHandle: handle ?? {
      agentId: "main",
      role: "main",
      describe: () => scope,
    },
    taskWorkContext: { branchGeneration: 1 },
  } as unknown as ToolExecutionContext;
  const host = createTaskGoalHost({
    goals,
    repository,
    refresh: async () => {},
  });
  return { host, root, context, goals, conversation, verified: () => verified };
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function crossRunFixture(legacy = false, canceled = false) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "goal-evidence-")),
  );
  roots.push(directory);
  const scope = {
    instanceId: RUNTIME_TEST_ACTOR.instanceId,
    projectId: "00000000-0000-4000-8000-000000000002",
    taskId: "00000000-0000-4000-8000-000000000003",
    rootDirectory: directory,
    additionalDirectories: [],
    sandboxMode: "workspace-write" as const,
    generation: 1,
  };
  const handle = await createExecutionScopes({
    repository: {
      load: async () => ({
        preset: "code",
        state: "ready",
        branchGeneration: 1,
        scope,
      }),
    },
    localInstance: createRuntimeTestInstance(),
  }).openTask(RUNTIME_TEST_ACTOR, scope.taskId);
  const f = await fixture(handle);
  const model = f.root.state!.goalModel;
  const sync = () => {
    f.root.state = f.conversation.exportState();
    if (model === undefined) delete f.root.state.goalModel;
    else f.root.state.goalModel = model;
  };
  const tool = (
    name: string,
    id: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
  ) => {
    f.conversation.recordEvent({
      type: "tool.started",
      runId: "r",
      toolCallId: id,
      toolName: name,
      input,
      timestamp: new Date(1000).toISOString(),
    });
    f.conversation.recordEvent({
      type: "tool.completed",
      runId: "r",
      toolCallId: id,
      toolName: name,
      status: "success",
      output,
      timestamp: new Date(2000).toISOString(),
    });
    sync();
  };
  sync();
  const receipt = await f.host.read(f.context);
  tool("GetGoal", "read-goal", {}, { ...receipt! });
  const commit = await handle.backend.writeFile({
    path: "C.txt",
    content: "goal-recovery-C\n",
    createOnly: true,
  });
  tool(
    "Write",
    "write-C",
    { file_path: "C.txt", content: "goal-recovery-C\n" },
    {
      display: fileDiffDisplay(commit, 10000),
    },
  );
  const writeRow = f.root.state!.snapshots[0]!.rows.window.find(
    (row) => row.kind === "toolCall" && row.toolName === "Write",
  );
  if (writeRow?.kind !== "toolCall")
    throw new Error("Missing actual Write receipt");
  writeRow.output!.text = `已创建 ${commit.filePath}，版本 ${commit.version}`;
  const state = JSON.parse(JSON.stringify(f.root.state!));
  f.conversation = createCodeUiConversation({
    sessionId: scope.taskId,
    workspacePath: directory,
    config: state.snapshots[0].config,
    state,
  });
  f.conversation.recordEvent({
    type: canceled ? "run.canceled" : "run.completed",
    runId: "r",
    timestamp: new Date(3000).toISOString(),
  });
  if (canceled) {
    const paused = f.conversation.getGoal()!;
    f.conversation.setGoal(
      f.goals.resume(paused, {
        goalId: paused.goalId,
        revision: paused.revision,
        branchGeneration: 1,
      }),
      model,
    );
  }
  f.conversation.startTurn({
    runId: "r2",
    commandId: "continue",
    text: "验收已有C文件",
  });
  sync();
  if (legacy)
    delete (f.root.state!.goalRecord as unknown as Record<string, unknown>)
      .runs;
  f.root.state = JSON.parse(JSON.stringify(f.root.state));
  f.root.active_run_id = "r2";
  f.context.runId = "r2";
  return {
    ...f,
    handle,
    path: commit.filePath,
    writeId: `row:${writeRow.rowId}`,
  };
}

it.each([false, true])(
  "同Goal真实claim跨Run及冷恢复继承成功Write，前Run取消=%s",
  async (canceled) => {
    const f = await crossRunFixture(false, canceled);
    const view = await f.host.read(f.context);
    expect(view?.evidenceCandidates).toContainEqual({
      id: f.writeId,
      kind: "toolCall",
      revision: f.root.state!.goalRecord!.revision,
    });
    const result = await f.host.verify(f.context, {
      ...proposal,
      revision: f.root.state!.goalRecord!.revision,
      evidenceIds: [f.writeId],
    });
    expect(result.status).toBe("complete");
    expect(f.context.requestModel).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining("goal-recovery-C"),
      }),
    );
  },
);

it("旧Goal只依据同Task已认证GetGoal回执确定历史成员并持久保留", async () => {
  const f = await crossRunFixture(true);
  expect((await f.host.read(f.context))?.evidenceCandidates).toContainEqual({
    id: f.writeId,
    kind: "toolCall",
    revision: f.root.state!.goalRecord!.revision,
  });
  await f.host.verify(f.context, {
    ...proposal,
    revision: f.root.state!.goalRecord!.revision,
    evidenceIds: [f.writeId],
  });
  expect(f.root.state!.goalRecord).toMatchObject({
    runs: expect.arrayContaining([
      { runId: "r", branchGeneration: 1, iteration: 1 },
    ]),
  });
});

it.each([
  "goalId",
  "objective",
  "branch",
  "run",
  "pending",
  "assistant",
  "prefix",
])("%s伪造或不匹配的旧GetGoal来源不能认领历史证据", async (change) => {
  const f = await crossRunFixture(true);
  const rows = f.root.state!.snapshots[0]!.rows.window;
  const membership = rows.find(
    (row) => row.kind === "toolCall" && row.toolName === "GetGoal",
  );
  if (membership?.kind !== "toolCall")
    throw new Error("Missing GetGoal source");
  const body = JSON.parse(membership.output!.text);
  if (change === "goalId") body.goalId = "another-goal";
  if (change === "objective") body.objective = "another objective";
  if (change === "branch") body.branchGeneration = 2;
  if (change === "run") body.claimedRunId = "foreign-run";
  if (change === "pending") membership.status = "pendingApproval";
  if (change === "prefix") membership.toolCallId = "foreign-run/copied";
  membership.output!.text = JSON.stringify(body);
  if (change === "assistant")
    rows.splice(
      rows.indexOf(membership),
      1,
      protocol.assistantTextRowSchema.parse({
        rowId: membership.rowId,
        turnId: "r",
        kind: "assistantText",
        text: JSON.stringify(body),
        state: "complete",
        createdAt: 0,
        createdAtSeq: 0,
      }),
    );
  expect((await f.host.read(f.context))?.evidenceCandidates).not.toContainEqual(
    expect.objectContaining({ id: f.writeId }),
  );
  await expect(
    f.host.verify(f.context, {
      ...proposal,
      revision: f.root.state!.goalRecord!.revision,
      evidenceIds: [f.writeId],
    }),
  ).rejects.toThrow("验收引用");
  expect(f.context.requestModel).not.toHaveBeenCalled();
});

it.each(["error", "cancelled", "pendingApproval"] as const)(
  "历史Write回执%s不继承未完成操作",
  async (status) => {
    const f = await crossRunFixture();
    const row = f.root.state!.snapshots[0]!.rows.window.find(
      (row) => `row:${row.rowId}` === f.writeId,
    );
    if (row?.kind !== "toolCall") throw new Error("Missing Write source");
    row.status = status;
    expect(
      (await f.host.read(f.context))?.evidenceCandidates,
    ).not.toContainEqual(expect.objectContaining({ id: f.writeId }));
    await expect(
      f.host.verify(f.context, {
        ...proposal,
        revision: f.root.state!.goalRecord!.revision,
        evidenceIds: [f.writeId],
      }),
    ).rejects.toThrow("验收引用");
    expect(f.context.requestModel).not.toHaveBeenCalled();
  },
);

it.each(["before", "during"])(
  "文件在%s独立评估删除时旧Write不能完成Goal",
  async (phase) => {
    const f = await crossRunFixture();
    if (phase === "before") await unlink(f.path);
    else
      f.context.requestModel = vi.fn(async () => {
        await unlink(f.path);
        return {
          text: '{"passed":true,"reason":"Review"}',
          hasToolCalls: false,
          usageObserved: true,
        };
      });
    await expect(
      f.host.verify(f.context, {
        ...proposal,
        revision: f.root.state!.goalRecord!.revision,
        evidenceIds: [f.writeId],
      }),
    ).rejects.toThrow();
    expect(f.root.state!.goalRecord!.status).not.toBe("complete");
    if (phase === "before")
      expect(f.context.requestModel).not.toHaveBeenCalled();
  },
);

it.each(["task", "project", "branch", "scope"])(
  "跨Run证据不绕过当前%s绑定",
  async (boundary) => {
    const f = await crossRunFixture();
    if (boundary === "task") f.root.id = "foreign-task";
    if (boundary === "project") f.root.project_id = "foreign-project";
    if (boundary === "branch") f.root.branch_generation = 2;
    if (boundary === "scope") f.root.scope_generation = 2;
    await expect(
      f.host.verify(f.context, {
        ...proposal,
        revision: f.root.state!.goalRecord!.revision,
        evidenceIds: [f.writeId],
      }),
    ).rejects.toThrow();
    expect(f.context.requestModel).not.toHaveBeenCalled();
  },
);
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
