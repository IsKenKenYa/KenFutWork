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
import { z } from "zod";
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
  readNativePostMessages,
  runIds,
  snapshot,
  task,
  waitForPartial,
  waitForSseClosure,
  withModeFixture,
} from "./guide-state-test.fixture.js";

const INPUT_TEXT =
  "PLAN_MODE_SCOPE_A_f8ace29b：保持原只读工作域，等待模式RPC。";
const WRITABLE_INPUT_TEXT =
  "PLAN_MODE_WRITABLE_A_eb7bd645：保持原可写工作域，等待模式RPC及原命令重放。";
type ScopeBaseline = "read-only" | "danger-full-access";

function modelText(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = z
    .array(
      z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
    )
    .parse(content);
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

async function readScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
    undefined,
    "GET",
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function selectYoloBase(fixture: Fixture, host: Host) {
  const idle = await snapshot(host);
  const selected = modelSelectionSchema.parse(idle.config.modelSelection);
  expect(selected.modelId).toBe(GUIDE_MODE_MODEL);
  const yolo = await host.command(
    "switchCollaborationMode",
    { mode: "yolo" },
    randomUUID(),
    {
      baseRevision: idle.revision,
      baseLogEpoch: idle.logEpoch,
    },
  );
  expect(yolo.status, JSON.stringify(yolo.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(yolo.body.result).status).toBe(
    "accepted",
  );
  const beforeScope = await readScope(host);
  const beforeTask = await task(fixture, host);
  expect(beforeScope.sandboxMode).toBe("danger-full-access");
  expect((await snapshot(host)).config).toMatchObject({
    mode: "yolo",
    planEnabled: false,
  });
  return { selected, beforeScope, beforeTask };
}

async function establishScope(
  fixture: Fixture,
  host: Host,
  base: Awaited<ReturnType<typeof selectYoloBase>>,
  sandboxMode: ScopeBaseline,
) {
  const { beforeScope, beforeTask } = base;
  if (sandboxMode === "danger-full-access") {
    expect(await readScope(host)).toEqual(beforeScope);
    return beforeScope;
  }
  const changed = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
    { sandboxMode: "read-only" },
    "PATCH",
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  const scope = codeTaskScopeResponseSchema.parse(changed.body).scope;
  expect(scope.sandboxMode).toBe("read-only");
  expect(scope.generation).toBe(beforeScope.generation + 1);
  expect(scope.rootDirectory).toBe(beforeScope.rootDirectory);
  expect(scope.additionalDirectories).toEqual(
    beforeScope.additionalDirectories,
  );
  const narrowed = await task(fixture, host);
  expect(narrowed.branch_generation).toBe(beforeTask.branch_generation);
  expect(narrowed.execution_state).toBe("ready");
  expect((await snapshot(host)).config).toMatchObject({
    mode: "yolo",
    planEnabled: false,
  });
  return scope;
}

function assertInitialModel(model: Model, sandboxMode: ScopeBaseline) {
  const request = model.requests[0]?.body;
  if (!request) throw new Error("原A没有实际模型请求。");
  const system = request.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map((message) => modelText(message.content))
    .join("\n");
  expect(system).toContain("Task 审批模式：yolo；派发时权限上限：yolo");
  expect(system).toContain(`文件模式：${sandboxMode}`);
  const tools = request.tools?.map((tool) => tool.function.name);
  expect(tools).toContain("EnterPlanMode");
  if (sandboxMode === "read-only") expect(tools).not.toContain("Write");
  else expect(tools, "可写Scope原A必须实际广告Write。").toContain("Write");
}

async function prepareRun(
  fixture: Fixture,
  host: Host,
  model: Model,
  sandboxMode: ScopeBaseline,
) {
  const base = await selectYoloBase(fixture, host);
  const scope = await establishScope(fixture, host, base, sandboxMode);
  const inputText =
    sandboxMode === "read-only" ? INPUT_TEXT : WRITABLE_INPUT_TEXT;
  const commandId = randomUUID();
  const started = await host.command(
    "sendText",
    {
      text: inputText,
      modelSelection: base.selected,
      mode: "yolo",
      planEnabled: false,
    },
    commandId,
  );
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(started.body.result).status).toBe(
    "accepted",
  );
  const first = await waitForPartial(host, model, 0);
  const original = await task(fixture, host);
  expect(original.sandbox_mode).toBe(sandboxMode);
  expect(original.root_directory).toBe(host.workspacePath);
  expect(original.instance_id).toBe(fixture.actor.instanceId);
  expect(Number(original.scope_generation)).toBe(scope.generation);
  expect(original.branch_generation).toBe(base.beforeTask.branch_generation);
  const initial = original.state.inputs?.find(
    (entry) => entry.intent.sourceCommandId === commandId,
  );
  if (!initial) throw new Error("真实Scope的原A canonical输入缺失。");
  expect(initial.intent).toMatchObject({ mode: "yolo", planEnabled: false });
  assertInitialModel(model, sandboxMode);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readScope(host)).toEqual(scope);
  return {
    original,
    scope,
    first,
    commandId,
    inputText,
    epochBeforeMode: original.state.planningEpoch ?? 0,
    frozen: structuredClone(initial),
  };
}

type Initial = Awaited<ReturnType<typeof prepareRun>>;

async function assertStable(
  fixture: Fixture,
  host: Host,
  initial: Initial,
  activeRunId: string | null,
) {
  const current = await task(fixture, host);
  assertTaskUnchanged(current, initial.original, fixture, activeRunId);
  expect(await runIds(fixture, host)).toEqual([initial.first.runId]);
  expect(await readScope(host)).toEqual(initial.scope);
  const input = current.state.inputs?.find(
    (entry) => entry.intent.sourceCommandId === initial.commandId,
  );
  if (!input) throw new Error("模式RPC后原A输入丢失。");
  expect(input.intent).toEqual({
    ...initial.frozen.intent,
    dispatch: input.intent.dispatch,
  });
  expect(input.modelInvocation).toEqual(initial.frozen.modelInvocation);
  expect(input.scopeGeneration).toBe(initial.frozen.scopeGeneration);
  expect(input.branchGeneration).toBe(initial.frozen.branchGeneration);
  expect(current.state.inputs).toHaveLength(1);
  const value = await snapshot(host);
  expect(value.config).toMatchObject({ mode: "yolo", planEnabled: true });
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

async function assertControlToolFacts(
  fixture: Fixture,
  host: Host,
  initial: Initial,
) {
  const value = await snapshot(host);
  expect(
    value.rows.window.filter(
      (row) => row.kind === "toolCall" && row.toolName === "EnterPlanMode",
    ),
  ).toEqual([expect.objectContaining({ status: "success", input: {} })]);
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ payload: unknown }>(
      `select payload from public.code_ui_events where instance_id=:instance and root_session_id=$1
     and payload->>'type'='tool.completed' and payload->>'runId'=$2 and payload->>'toolName'='EnterPlanMode' order by seq`,
      [host.sessionId, initial.first.runId],
    );
  expect(rows.map((row) => streamEventSchema.parse(row.payload))).toEqual([
    expect.objectContaining({
      runId: initial.first.runId,
      toolCallId: ENTER_PLAN_CALL,
      status: "success",
    }),
  ]);
}

async function assertFinalNative(
  fixture: Fixture,
  host: Host,
  initial: Initial,
) {
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
}

async function assertHeldRun(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Initial,
) {
  await assertStable(fixture, host, initial, initial.first.runId);
  const held = await snapshot(host);
  expect(held.control).toMatchObject({ phase: "running", canStop: true });
  expect(held.control.activeWorks).toEqual([
    expect.objectContaining({
      kind: "primaryTurn",
      foregroundExecutionId: initial.first.runId,
    }),
  ]);
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]?.closed).toBe(false);
}

async function readModeReceipt(
  fixture: Fixture,
  host: Host,
  commandId: string,
) {
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ parameter_fingerprint: string; ack: unknown; status: string }>(
      `select parameter_fingerprint, ack, status from public.code_ui_commands
       where instance_id=:instance and client_id=$1 and command_id=$2 and session_id=$3`,
      [host.clientId, commandId, host.sessionId],
    );
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error("原模式命令的持久回执缺失。");
  return { ...row, ack: protocol.commandAckSchema.parse(row.ack) };
}

async function replayModeCommand(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Initial,
  commandId: string,
  guard: { baseRevision: number; baseLogEpoch: string },
  firstAck: protocol.CommandAck,
  epoch: number,
) {
  const receipt = await readModeReceipt(fixture, host, commandId);
  expect(receipt.status).toBe("accepted");
  expect(receipt.ack).toEqual(firstAck);
  // 原ID与guard顺序重放；issuedAt由真实host helper更新，不在命令指纹内。
  for (let index = 0; index < 2; index += 1) {
    const repeated = await host.command(
      "switchCollaborationMode",
      { mode: "plan" },
      commandId,
      guard,
    );
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
    expect(protocol.commandAckSchema.parse(repeated.body.result)).toEqual({
      ...firstAck,
      status: "duplicate",
    });
    await assertHeldRun(fixture, host, model, initial);
    expect((await task(fixture, host)).state.planningEpoch).toBe(epoch);
    expect(await readModeReceipt(fixture, host, commandId)).toEqual(receipt);
  }
}

async function assertWriteRejected(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Initial,
) {
  const request = model.requests[2]?.body;
  const calls = request?.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.id === GUIDE_MODE_WRITE_CALL);
  expect(calls).toHaveLength(1);
  expect(calls?.[0]?.function.name).toBe("Write");
  expect(JSON.parse(calls?.[0]?.function.arguments ?? "null")).toEqual({
    file_path: GUIDE_MODE_FILE,
    content: GUIDE_MODE_FILE_CONTENT,
  });
  const errors = request?.messages.filter(
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
}

async function runModeScopeScenario(
  fixture: Fixture,
  host: Host,
  model: Model,
  options: { sandboxMode: ScopeBaseline; replay: boolean },
) {
  const initial = await prepareRun(fixture, host, model, options.sandboxMode);
  const before = await snapshot(host);
  const commandId = randomUUID();
  const guard = {
    baseRevision: before.revision,
    baseLogEpoch: before.logEpoch,
  };
  const switched = await host.command(
    "switchCollaborationMode",
    { mode: "plan" },
    commandId,
    guard,
  );
  expect(switched.status, JSON.stringify(switched.body)).toBe(200);
  const firstAck = protocol.commandAckSchema.parse(switched.body.result);
  expect(firstAck.status).toBe("accepted");
  // 必须在A发真实Enter之前锁住RPC本体，后续Enter不能替坏RPC伪造成功。
  await assertHeldRun(fixture, host, model, initial);
  const epoch = (await task(fixture, host)).state.planningEpoch;
  expect(epoch).toBe(initial.epochBeforeMode + 1);
  if (epoch === undefined) throw new Error("原模式RPC没有持久规划代际。");
  if (options.replay) {
    await replayModeCommand(
      fixture,
      host,
      model,
      initial,
      commandId,
      guard,
      firstAck,
      epoch,
    );
  }
  model.finish(0);
  expect((await waitForPartial(host, model, 1)).runId).toBe(
    initial.first.runId,
  );
  await assertStable(fixture, host, initial, initial.first.runId);
  expect((await task(fixture, host)).state.planningEpoch).toBe(epoch);
  assertPolicyPrompt(model, 1, "plan", "yolo");
  await assertControlToolFacts(fixture, host, initial);
  model.finish(1);
  expect((await waitForPartial(host, model, 2)).runId).toBe(
    initial.first.runId,
  );
  await assertStable(fixture, host, initial, initial.first.runId);
  assertPolicyPrompt(model, 2, "plan", "yolo");
  await assertWriteRejected(fixture, host, model, initial);
  const ended = await finishAndWaitForCompletion(host, model, 2);
  await assertStable(fixture, host, initial, null);
  expect((await task(fixture, host)).state.planningEpoch).toBe(epoch);
  expect(ended.rows.window.filter((row) => row.kind === "turnHeader")).toEqual([
    expect.objectContaining({
      turnId: initial.first.runId,
      state: "completedSuccess",
    }),
  ]);
  await assertFinalNative(fixture, host, initial);
  await assertControlToolFacts(fixture, host, initial);
  await assertErrorToolFact(fixture, host, initial.first.runId);
  const completions = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ payload: unknown }>(
      `select payload from public.code_ui_events where instance_id=:instance and root_session_id=$1
       and payload->>'type'='tool.completed' and payload->>'runId'=$2 order by seq`,
      [host.sessionId, initial.first.runId],
    );
  expect(
    completions.map((row) => streamEventSchema.parse(row.payload)),
  ).toMatchObject([
    {
      toolName: "EnterPlanMode",
      toolCallId: ENTER_PLAN_CALL,
      status: "success",
    },
    { toolName: "Write", toolCallId: GUIDE_MODE_WRITE_CALL, status: "error" },
  ]);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(model.requests.map((request) => request.body.model)).toEqual(
    Array(3).fill(GUIDE_MODE_MODEL),
  );
  await waitForSseClosure(model, [true, true, true]);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "raw plan模式RPC保持既有Scope integration",
  () => {
    it("idle yolo后显式收窄Scope，持流mode=plan不升级/撤销Scope且原Run实际Write拒绝后自然结束", async () => {
      await withModeFixture(
        false,
        (fixture, host, model) =>
          runModeScopeScenario(fixture, host, model, {
            sandboxMode: "read-only",
            replay: false,
          }),
        enterPlanFixture,
      );
    }, 90_000); // 独占HTTP/PG与三段实际SSE期限，非运行时治理值。
    it("持流可写yolo的mode=plan不收窄Scope，同ID两次重放只复用回执且epoch只增一代", async () => {
      await withModeFixture(
        false,
        (fixture, host, model) =>
          runModeScopeScenario(fixture, host, model, {
            sandboxMode: "danger-full-access",
            replay: true,
          }),
        enterPlanFixture,
      );
    }, 90_000); // 独占HTTP/PG与三段实际SSE期限，非运行时治理值。
  },
);
