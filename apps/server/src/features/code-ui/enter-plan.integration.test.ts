import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { streamEventSchema } from "@kenfutwork/shared";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
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
  assertPolicyPrompt,
  assertTaskUnchanged,
  type Fixture,
  finishAndWaitForCompletion,
  type Host,
  type Model,
  prepareYoloRun,
  readNativePostMessages,
  runIds,
  snapshot,
  task,
  waitForPartial,
  waitForSseClosure,
  withModeFixture,
} from "./guide-state-test.fixture.js";

type Initial = Awaited<ReturnType<typeof prepareYoloRun>>;
const PLANNING_ENABLED =
  /规划(?:模式|状态)?\s*[：:]?\s*(?:已)?(?:开启|启用)|planning(?:\s+mode)?\s*(?:is\s*)?(?:enabled|on)\b|planEnabled\s*[:=]\s*true\b/iu;

async function assertEnteredState(
  fixture: Fixture,
  host: Host,
  initial: Initial,
  activeRunId: string | null,
) {
  const current = await task(fixture, host);
  assertTaskUnchanged(current, initial.original, fixture, activeRunId);
  expect(await runIds(fixture, host)).toEqual([initial.first.runId]);
  const original = current.state.inputs?.find(
    (input) => input.intent.sourceCommandId === initial.initialCommandId,
  );
  if (!original) throw new Error("Enter后原A canonical输入丢失。");
  expect(original.intent).toEqual({
    ...initial.frozenA.intent,
    dispatch: original.intent.dispatch,
  });
  expect(original.intent).toMatchObject({ mode: "yolo", planEnabled: false });
  expect(original.modelInvocation).toEqual(initial.frozenA.modelInvocation);
  expect(original.scopeGeneration).toBe(initial.frozenA.scopeGeneration);
  expect(original.branchGeneration).toBe(initial.frozenA.branchGeneration);
  expect(current.state.inputs).toHaveLength(1);
  const value = await snapshot(host);
  expect(value.config).toMatchObject({ mode: "yolo", planEnabled: true });
  expect(value.pendingInteractions).toEqual([]);
  expect(value.queue.items).toEqual([]);
  const users = value.rows.window.filter((row) => row.kind === "userInput");
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({
    sourceCommandId: initial.initialCommandId,
    turnId: initial.first.runId,
    clientId: host.clientId,
  });
  expect(users.filter((row) => row.guided)).toEqual([]);
}

function assertEnteredPrompt(model: Model, index: number) {
  assertPolicyPrompt(model, index, "plan", "yolo");
  const request = model.requests[index]?.body;
  if (!request) throw new Error("Enter之后没有真实模型请求。");
  const system = request.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
  expect(system).toMatch(PLANNING_ENABLED);
}

function assertEnterResult(model: Model, index: number) {
  const request = model.requests[index]?.body;
  if (!request) throw new Error("模型请求未携带实际Enter结果。");
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
}

async function assertEnterFacts(fixture: Fixture, host: Host, runId: string) {
  const value = await snapshot(host);
  const rows = value.rows.window.filter(
    (row) => row.kind === "toolCall" && row.toolName === "EnterPlanMode",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "success", input: {} });
  // 文件恢复reader只读Write/Edit/ApplyPatch；控制事实读取原journal而不扩文件接口。
  const journal = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ payload: unknown }>(
      `select payload from public.code_ui_events
       where instance_id=:instance and root_session_id=$1
       and payload->>'type'='tool.completed' and payload->>'runId'=$2
       and payload->>'toolName'='EnterPlanMode' order by seq`,
      [host.sessionId, runId],
    );
  const events = journal.map((row) => streamEventSchema.parse(row.payload));
  expect(events).toEqual([
    expect.objectContaining({
      runId,
      toolCallId: ENTER_PLAN_CALL,
      status: "success",
    }),
  ]);
}

async function assertEnterNative(
  fixture: Fixture,
  host: Host,
  initial: Initial,
) {
  const messages = await readNativePostMessages(
    fixture,
    host,
    initial.first.runId,
  );
  const human = messages.filter(HumanMessage.isInstance);
  expect(human).toHaveLength(1);
  expect(human[0]?.content).toBe(initial.frozenA.intent.text);
  const enter = messages
    .filter(ToolMessage.isInstance)
    .filter((message) => message.tool_call_id === ENTER_PLAN_CALL);
  expect(enter).toHaveLength(1);
  expect(enter[0]?.status).toBe("success");
  const writes = messages
    .filter(ToolMessage.isInstance)
    .filter((message) => message.tool_call_id === GUIDE_MODE_WRITE_CALL);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.status).toBe("error");
  expect(JSON.stringify(writes[0]?.content)).toMatch(
    /plan|只读|拒绝|权限|permission|denied/i,
  );
  expect(messages.filter(AIMessage.isInstance)).toContainEqual(
    expect.objectContaining({ content: ENTER_PLAN_TEXTS[2] }),
  );
}

async function runEnterPlanScenario(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const initial = await prepareYoloRun(fixture, host, model);
  expect(initial.first.active.config).toMatchObject({
    mode: "yolo",
    planEnabled: false,
  });
  // 存在只是第一可观察边界；后续必须验证真实结果/收紧/拒绝与自然结束。
  expect(
    model.requests[0]?.body.tools?.map((tool) => tool.function.name),
  ).toContain("EnterPlanMode");
  model.finish(0);
  const second = await waitForPartial(host, model, 1);
  expect(second.runId).toBe(initial.first.runId);
  assertEnterResult(model, 1);
  await assertEnteredState(fixture, host, initial, initial.first.runId);
  assertEnteredPrompt(model, 1);
  await assertEnterFacts(fixture, host, initial.first.runId);
  model.finish(1);
  const third = await waitForPartial(host, model, 2);
  expect(third.runId).toBe(initial.first.runId);
  assertEnterResult(model, 2);
  assertEnteredPrompt(model, 2);
  await assertEnteredState(fixture, host, initial, initial.first.runId);
  const writes = model.requests[2]?.body.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.id === GUIDE_MODE_WRITE_CALL);
  expect(writes).toHaveLength(1);
  expect(writes?.[0]?.function.name).toBe("Write");
  expect(JSON.parse(writes?.[0]?.function.arguments ?? "null")).toEqual({
    file_path: GUIDE_MODE_FILE,
    content: GUIDE_MODE_FILE_CONTENT,
  });
  const errors = model.requests[2]?.body.messages.filter(
    (message) =>
      message.role === "tool" && message.tool_call_id === GUIDE_MODE_WRITE_CALL,
  );
  expect(errors).toHaveLength(1);
  expect(JSON.stringify(errors?.[0]?.content)).toMatch(
    /plan|只读|拒绝|权限|permission|denied/i,
  );
  await assertErrorToolFact(fixture, host, initial.first.runId);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const ended = await finishAndWaitForCompletion(host, model, 2);
  await assertEnteredState(fixture, host, initial, null);
  const headers = ended.rows.window.filter((row) => row.kind === "turnHeader");
  expect(headers).toEqual([
    expect.objectContaining({
      turnId: initial.first.runId,
      state: "completedSuccess",
    }),
  ]);
  await assertEnterNative(fixture, host, initial);
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

/** 尚未实施/尚未跑RED；只验证主Run Enter收紧，Exit人审/文件是后续独立切片。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code实际EnterPlanMode integration",
  () => {
    it("原yolo Run的真实Enter工具开启规划，同Run拒绝Write且无permission等待/伪guide行", async () => {
      await withModeFixture(false, runEnterPlanScenario, enterPlanFixture);
    }, 90_000); // 独占HTTP/PG与三段真实SSE期限，非运行时治理值。
  },
);
