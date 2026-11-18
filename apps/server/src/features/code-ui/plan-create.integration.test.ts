import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
  streamEventSchema,
} from "@kenfutwork/shared";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { modelSelectionSchema } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  ENTER_PLAN_CALL,
  ENTER_PLAN_TEXTS,
  enterPlanFixture,
} from "./enter-plan.fixture.js";
import {
  GUIDE_MODE_FILE,
  GUIDE_MODE_FILE_CONTENT,
  GUIDE_MODE_MODEL,
  GUIDE_MODE_WRITE_CALL,
} from "./guide-mode.fixture.js";
import {
  assertErrorToolFact,
  assertTaskUnchanged,
  type Fixture,
  finishAndWaitForCompletion,
  type Host,
  type Model,
  readNativePostMessages,
  runIds,
  snapshot,
  task,
  waitForPartial,
  waitForSseClosure,
} from "./guide-state-test.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";

const INPUT_TEXT =
  "PLAN_CREATE_A_76ea88e4：继续新Task的规划，调用原Enter再验证Write权限。";
const EXPLICIT_FALSE_INPUT_TEXT =
  "PLAN_CREATE_FALSE_A_c462d7b1：先保持build，调用原Enter再验证Write权限。";

async function readScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
    undefined,
    "GET",
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

function assertRequestPolicy(
  model: Model,
  index: number,
  mode: "build" | "plan",
  ceiling: "build" | "plan",
) {
  const request = model.requests[index]?.body;
  if (!request) throw new Error("缺少真实模型HTTP请求。");
  const system = request.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
  expect(system).toContain(
    `Task 审批模式：${mode}；派发时权限上限：${ceiling}`,
  );
  expect(system).toContain("文件模式：workspace-write");
  expect(system).toContain(
    mode === "plan" ? "规划状态：开启" : "规划状态：关闭",
  );
  const tools = request.tools?.map((tool) => tool.function.name) ?? [];
  expect(tools).toContain("EnterPlanMode");
  // 原code-policy的build写权限为ask；catalogue只过滤deny，故仍广告Write。
  if (mode === "build") expect(tools).toContain("Write");
  else expect(tools, "plan模型边界不得继续曝光Write。").not.toContain("Write");
  expect(request.model).toBe(GUIDE_MODE_MODEL);
}

async function assertCreatedTask(
  fixture: Fixture,
  host: Host,
  model: Model,
  initialPlanEnabled: boolean,
) {
  // 位于create ACK之后且sendText之前，避免首次输入归一化掩盖创建错误。
  const created = await snapshot(host);
  expect(created.config).toMatchObject({
    mode: "build",
    planEnabled: initialPlanEnabled,
  });
  const selected = modelSelectionSchema.parse(created.config.modelSelection);
  expect(selected.modelId).toBe(GUIDE_MODE_MODEL);
  const scope = await readScope(host);
  expect(scope).toEqual({
    instanceId: fixture.actor.instanceId,
    projectId: host.projectId,
    taskId: host.sessionId,
    generation: 0,
    rootDirectory: host.workspacePath,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  });
  const original = await task(fixture, host);
  expect(original).toMatchObject({
    id: host.sessionId,
    instance_id: fixture.actor.instanceId,
    project_id: host.projectId,
    root_session_id: host.sessionId,
    chat_session_id: host.sessionId,
    parent_session_id: null,
    root_directory: host.workspacePath,
    additional_directories: scope.additionalDirectories,
    sandbox_mode: "workspace-write",
    execution_state: "ready",
    active_run_id: null,
  });
  expect(Number(original.scope_generation)).toBe(0);
  expect(Number(original.branch_generation)).toBe(1);
  expect(original.state.inputs ?? []).toEqual([]);
  expect(await runIds(fixture, host)).toEqual([]);
  expect(created.control.activeWorks).toEqual([]);
  expect(created.pendingInteractions).toEqual([]);
  expect(created.queue.items).toEqual([]);
  expect(created.rows.window).toEqual([]);
  expect(model.requests).toEqual([]);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  return { original, scope, selected };
}

async function prepareRun(
  fixture: Fixture,
  host: Host,
  model: Model,
  initialPlanEnabled: boolean,
) {
  const creation = await assertCreatedTask(
    fixture,
    host,
    model,
    initialPlanEnabled,
  );
  const inputText = initialPlanEnabled ? INPUT_TEXT : EXPLICIT_FALSE_INPUT_TEXT;
  const commandId = randomUUID();
  const started = await host.command(
    "sendText",
    { text: inputText, modelSelection: creation.selected },
    commandId,
  );
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(started.body.result).status).toBe(
    "accepted",
  );
  const first = await waitForPartial(host, model, 0);
  const current = await task(fixture, host);
  assertTaskUnchanged(current, creation.original, fixture, first.runId);
  const input = current.state.inputs?.find(
    (entry) => entry.intent.sourceCommandId === commandId,
  );
  if (!input) throw new Error("新Task的原A canonical输入未持久化。");
  expect(input.intent).toMatchObject({
    mode: "build",
    planEnabled: initialPlanEnabled,
  });
  expect(input.scopeGeneration).toBe(0);
  expect(input.branchGeneration).toBe(1);
  expect(current.state.planningEpoch ?? 0).toBe(
    creation.original.state.planningEpoch ?? 0,
  );
  const initialMode = initialPlanEnabled ? "plan" : "build";
  assertRequestPolicy(model, 0, initialMode, initialMode);
  expect(
    model.requests[0]?.body.tools?.map((tool) => tool.function.name),
  ).toContain("EnterPlanMode");
  expect(await readScope(host)).toEqual(creation.scope);
  return {
    ...creation,
    first,
    commandId,
    inputText,
    initialPlanEnabled,
    frozen: structuredClone(input),
  };
}

type Initial = Awaited<ReturnType<typeof prepareRun>>;

async function assertStable(
  fixture: Fixture,
  host: Host,
  initial: Initial,
  activeRunId: string | null,
  entered: boolean,
) {
  const current = await task(fixture, host);
  assertTaskUnchanged(current, initial.original, fixture, activeRunId);
  expect(await runIds(fixture, host)).toEqual([initial.first.runId]);
  expect(await readScope(host)).toEqual(initial.scope);
  expect(current.state.planningEpoch ?? 0).toBe(
    (initial.original.state.planningEpoch ?? 0) +
      (entered && !initial.initialPlanEnabled ? 1 : 0),
  );
  const input = current.state.inputs?.find(
    (entry) => entry.intent.sourceCommandId === initial.commandId,
  );
  if (!input) throw new Error("原Enter后首条canonical输入丢失。");
  expect(input.intent).toEqual({
    ...initial.frozen.intent,
    dispatch: input.intent.dispatch,
  });
  expect(input.modelInvocation).toEqual(initial.frozen.modelInvocation);
  expect(input.scopeGeneration).toBe(initial.frozen.scopeGeneration);
  expect(input.branchGeneration).toBe(initial.frozen.branchGeneration);
  expect(current.state.inputs).toHaveLength(1);
  const value = await snapshot(host);
  expect(value.config).toMatchObject({
    mode: "build",
    planEnabled: entered || initial.initialPlanEnabled,
  });
  expect(value.config.modelSelection).toEqual(initial.selected);
  expect(value.pendingInteractions).toEqual([]);
  expect(value.queue.items).toEqual([]);
  expect(value.rows.window.filter((row) => row.kind === "userInput")).toEqual([
    expect.objectContaining({
      sourceCommandId: initial.commandId,
      turnId: initial.first.runId,
      text: initial.inputText,
      clientId: host.clientId,
    }),
  ]);
  expect(
    value.rows.window.filter((row) => row.kind === "userInput" && row.guided),
  ).toEqual([]);
}

function assertEnterResult(
  model: Model,
  index: number,
  ceiling: "build" | "plan",
) {
  const request = model.requests[index]?.body;
  if (!request) throw new Error("实际模型请求缺少原Enter结果。");
  const calls = request.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.id === ENTER_PLAN_CALL);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.function.name).toBe("EnterPlanMode");
  expect(JSON.parse(calls[0]?.function.arguments ?? "null")).toEqual({});
  expect(
    request.messages.filter(
      (message) =>
        message.role === "tool" && message.tool_call_id === ENTER_PLAN_CALL,
    ),
  ).toHaveLength(1);
  assertRequestPolicy(model, index, "plan", ceiling);
}

async function assertEnterFacts(fixture: Fixture, host: Host, runId: string) {
  const value = await snapshot(host);
  expect(
    value.rows.window.filter(
      (row) => row.kind === "toolCall" && row.toolName === "EnterPlanMode",
    ),
  ).toEqual([expect.objectContaining({ status: "success", input: {} })]);
  // 文件事实reader仅覆盖Write/Edit/ApplyPatch；控制工具仍读原journal。
  const journal = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ payload: unknown }>(
      `select payload from public.code_ui_events
       where instance_id=:instance and root_session_id=$1
       and payload->>'type'='tool.completed' and payload->>'runId'=$2
       and payload->>'toolName'='EnterPlanMode' order by seq`,
      [host.sessionId, runId],
    );
  expect(journal.map((row) => streamEventSchema.parse(row.payload))).toEqual([
    expect.objectContaining({
      runId,
      toolCallId: ENTER_PLAN_CALL,
      status: "success",
    }),
  ]);
}

function assertWriteResult(model: Model) {
  const request = model.requests[2]?.body;
  if (!request) throw new Error("真实Write管线未回到C模型请求。");
  const calls = request.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.id === GUIDE_MODE_WRITE_CALL);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.function.name).toBe("Write");
  expect(JSON.parse(calls[0]?.function.arguments ?? "null")).toEqual({
    file_path: GUIDE_MODE_FILE,
    content: GUIDE_MODE_FILE_CONTENT,
  });
  const errors = request.messages.filter(
    (message) =>
      message.role === "tool" && message.tool_call_id === GUIDE_MODE_WRITE_CALL,
  );
  expect(errors).toHaveLength(1);
  expect(JSON.stringify(errors[0]?.content)).toMatch(
    /plan|只读|拒绝|权限|permission|denied/i,
  );
}

async function runScenario(
  fixture: Fixture,
  host: Host,
  model: Model,
  initialPlanEnabled: boolean,
) {
  const initial = await prepareRun(fixture, host, model, initialPlanEnabled);
  const ceiling = initialPlanEnabled ? "plan" : "build";
  await assertStable(fixture, host, initial, initial.first.runId, false);
  model.finish(0);
  const second = await waitForPartial(host, model, 1);
  expect(second.runId).toBe(initial.first.runId);
  assertEnterResult(model, 1, ceiling);
  await assertStable(fixture, host, initial, initial.first.runId, true);
  await assertEnterFacts(fixture, host, initial.first.runId);
  model.finish(1);
  const third = await waitForPartial(host, model, 2);
  expect(third.runId).toBe(initial.first.runId);
  assertEnterResult(model, 2, ceiling);
  assertWriteResult(model);
  await assertStable(fixture, host, initial, initial.first.runId, true);
  await assertErrorToolFact(fixture, host, initial.first.runId);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const ended = await finishAndWaitForCompletion(host, model, 2);
  await assertStable(fixture, host, initial, null, true);
  expect(ended.rows.window.filter((row) => row.kind === "turnHeader")).toEqual([
    expect.objectContaining({
      turnId: initial.first.runId,
      state: "completedSuccess",
    }),
  ]);
  const messages = await readNativePostMessages(
    fixture,
    host,
    initial.first.runId,
  );
  expect(messages.filter(HumanMessage.isInstance)).toEqual([
    expect.objectContaining({ content: initial.inputText }),
  ]);
  expect(
    messages
      .filter(ToolMessage.isInstance)
      .map((message) => ({ id: message.tool_call_id, status: message.status })),
  ).toEqual([
    { id: ENTER_PLAN_CALL, status: "success" },
    { id: GUIDE_MODE_WRITE_CALL, status: "error" },
  ]);
  expect(messages.filter(AIMessage.isInstance)).toContainEqual(
    expect.objectContaining({ content: ENTER_PLAN_TEXTS[2] }),
  );
  await assertEnterFacts(fixture, host, initial.first.runId);
  await assertErrorToolFact(fixture, host, initial.first.runId);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(model.requests.map((request) => request.body.model)).toEqual([
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
  ]);
  await waitForSseClosure(model, [true, true, true]);
}

async function runPlanCreateCase(
  initialConfig: NonNullable<
    protocol.CommandPayloadMap["createSession"]["config"]
  >,
  initialPlanEnabled: boolean,
) {
  const model = await enterPlanFixture();
  let fixture: Fixture | undefined;
  let host: Host | undefined;
  try {
    fixture = await createCodeUiHttpFixture();
    host = await createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
      initialConfig,
    });
    await runScenario(fixture, host, model, initialPlanEnabled);
  } finally {
    try {
      if (host && (await snapshot(host)).control.activeWorks.length)
        await host.command("stop", {});
    } finally {
      try {
        await model.close();
      } finally {
        try {
          await host?.dispose();
        } finally {
          await fixture?.close();
        }
      }
    }
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code新Task原raw plan创建 integration",
  () => {
    it("create config只传原plan即build/true且保留可写Scope，原Enter幂等后Write拒绝并自然完成", async () => {
      await runPlanCreateCase({ mode: "plan" }, true);
    }, 90_000); // 独占HTTP/PG与原三段SSE期限，非运行时治理值。

    it("create原plan的显式false压过别名，保持build与可写Scope；原Enter开启规划后同Run拒绝Write", async () => {
      await runPlanCreateCase({ mode: "plan", planEnabled: false }, false);
    }, 90_000); // 每例独占HTTP/PG与原三段SSE，禁止并行另启检查。
  },
);
