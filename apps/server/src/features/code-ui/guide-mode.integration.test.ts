import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { modelSelectionSchema } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { decodeNativeContextReference } from "../../agent/native-context-reference.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  GUIDE_MODE_C_TEXT,
  GUIDE_MODE_D_TEXT,
  GUIDE_MODE_FILE,
  GUIDE_MODE_FILE_CONTENT,
  GUIDE_MODE_MODEL,
  GUIDE_MODE_SUCCESS_CALL,
  GUIDE_MODE_SUCCESS_CONTENT,
  GUIDE_MODE_WRITE_CALL,
  guideModeFixture,
} from "./guide-mode.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { createCodeUiRepository } from "./repository.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof guideModeFixture>>;
const INITIAL_TEXT = "保持yolo正文流，等待下一条指导。";
const GUIDE_TEXT =
  "GUIDE_MODE_PLAN_ONLY_04bc70e1：从下一模型边界保持只读plan。";
const RESTORE_GUIDE_TEXT =
  "GUIDE_MODE_YOLO_RESTORE_ba1f7c63：从下一模型边界恢复yolo。";

async function snapshot(host: Host) {
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

async function task(fixture: Fixture, host: Host) {
  const record = await createCodeUiRepository(
    fixture.database.persistence,
  ).find(fixture.actor.instanceId, host.sessionId);
  if (!record?.state) throw new Error("真实Task与canonical输入未持久化。");
  return { ...record, state: record.state };
}

async function runIds(fixture: Fixture, host: Host) {
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ id: string }>(
      `select r.id from public.agent_runs r
       join public.code_ui_sessions t on t.chat_session_id=r.session_id
       where t.instance_id=:instance and t.id=$1 and t.parent_session_id is null
       order by r.id`,
      [host.sessionId],
    );
  return rows.map((row) => row.id);
}

function assertPolicyPrompt(
  model: Model,
  index: number,
  mode: "yolo" | "plan",
) {
  const request = model.requests[index]?.body;
  if (!request) throw new Error("缺少实际模型HTTP请求。");
  const system = request.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
  expect(system).toContain(`Task 审批模式：${mode}；派发时权限上限：yolo`);
  const tools = request.tools?.map((tool) => tool.function.name) ?? [];
  if (mode === "yolo")
    expect(tools, "前置：实际A应曝光可写Write。").toContain("Write");
  else expect(tools, "plan模型边界不得继续曝光Write。").not.toContain("Write");
  expect(request.model).toBe(GUIDE_MODE_MODEL);
}

async function waitForPartial(host: Host, model: Model, index: number) {
  return vi.waitFor(
    async () => {
      expect(model.requests).toHaveLength(index + 1);
      const active = await snapshot(host);
      expect(active.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          text: model.texts[index],
          state: "streaming",
        }),
      );
      const primary = active.control.activeWorks.filter(
        (work) => work.kind === "primaryTurn",
      );
      expect(primary).toHaveLength(1);
      const runId = primary[0]?.foregroundExecutionId;
      if (!runId) throw new Error("真实模型正文缺少活动Run。");
      expect(active.pendingInteractions).toEqual([]);
      return { active, runId };
    },
    { timeout: 30_000 },
  );
}

function assertTaskUnchanged(
  current: Awaited<ReturnType<typeof task>>,
  original: Awaited<ReturnType<typeof task>>,
  fixture: Fixture,
  activeRunId: string | null,
) {
  expect(current).toMatchObject({
    id: original.id,
    instance_id: fixture.actor.instanceId,
    project_id: original.project_id,
    root_directory: original.root_directory,
    additional_directories: original.additional_directories,
    scope_generation: original.scope_generation,
    branch_generation: original.branch_generation,
    sandbox_mode: original.sandbox_mode,
    execution_state: "ready",
    active_run_id: activeRunId,
  });
}

async function prepareYoloRun(fixture: Fixture, host: Host, model: Model) {
  const idle = await snapshot(host);
  const selected = modelSelectionSchema.parse(idle.config.modelSelection);
  expect(selected.modelId, "前置：使用原fixture的有效模型。").toBe(
    GUIDE_MODE_MODEL,
  );
  const changed = await host.command(
    "switchCollaborationMode",
    { mode: "yolo" },
    randomUUID(),
    {
      baseRevision: idle.revision,
      baseLogEpoch: idle.logEpoch,
    },
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(changed.body.result).status).toBe(
    "accepted",
  );
  const yolo = await snapshot(host);
  // 必须验证原RPC实际生效，不能只把yolo写进payload或外部模型提示。
  expect(yolo.config).toMatchObject({ mode: "yolo", planEnabled: false });
  const initialCommandId = randomUUID();
  const started = await host.command(
    "sendText",
    {
      text: INITIAL_TEXT,
      modelSelection: selected,
      mode: "yolo",
      planEnabled: false,
    },
    initialCommandId,
  );
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(started.body.result).status).toBe(
    "accepted",
  );
  const first = await waitForPartial(host, model, 0);
  expect(first.active.config).toMatchObject({
    mode: "yolo",
    planEnabled: false,
  });
  assertPolicyPrompt(model, 0, "yolo");
  const original = await task(fixture, host);
  expect(original.sandbox_mode, "前置：原yolo作用域必须允许新文件写入。").toBe(
    "danger-full-access",
  );
  expect(original.root_directory).toBe(host.workspacePath);
  expect(await runIds(fixture, host)).toEqual([first.runId]);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const initialInput = original.state.inputs?.find(
    (input) => input.intent.sourceCommandId === initialCommandId,
  );
  if (!initialInput) throw new Error("前置：A缺少真实canonical输入。");
  const frozenA = structuredClone(initialInput);
  return { first, original, selected, initialCommandId, frozenA };
}

async function prepareModeGuide(fixture: Fixture, host: Host, model: Model) {
  const started = await prepareYoloRun(fixture, host, model);
  const { first, original, selected, initialCommandId, frozenA } = started;
  const beforeConfig = await snapshot(host);
  const configured = await host.command(
    "setFollowupMode",
    { mode: "guide" },
    randomUUID(),
    {
      baseRevision: beforeConfig.revision,
      baseLogEpoch: beforeConfig.logEpoch,
    },
  );
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(configured.body.result).status).toBe(
    "accepted",
  );
  const guideCommandId = randomUUID();
  const payload = {
    text: GUIDE_TEXT,
    modelSelection: selected,
    mode: "plan",
    planEnabled: false,
  };
  const accepted = await host.command("sendText", payload, guideCommandId);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(accepted.body.result);
  expect(ack).toMatchObject({
    status: "accepted",
    result: {
      type: "inputAccepted",
      delivery: "queue",
      inputId: guideCommandId,
    },
  });
  const admission = await task(fixture, host);
  const guide = admission.state.inputs?.find(
    (input) => input.intent.sourceCommandId === guideCommandId,
  );
  expect(guide?.intent).toMatchObject({
    modelSelection: selected,
    mode: "plan",
    planEnabled: false,
  });
  assertTaskUnchanged(admission, original, fixture, first.runId);
  const replay = await host.command("sendText", payload, guideCommandId);
  expect(protocol.commandAckSchema.parse(replay.body.result)).toEqual({
    ...ack,
    status: "duplicate",
  });
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]?.closed).toBe(false);
  return {
    first,
    original,
    selected,
    initialCommandId,
    guideCommandId,
    frozenA,
  };
}

async function assertGuidedMode(
  fixture: Fixture,
  host: Host,
  prepared: Awaited<ReturnType<typeof prepareModeGuide>>,
  activeRunId: string | null,
) {
  const current = await task(fixture, host);
  assertTaskUnchanged(current, prepared.original, fixture, activeRunId);
  expect(await runIds(fixture, host)).toEqual([prepared.first.runId]);
  const initial = current.state.inputs?.find(
    (input) => input.intent.sourceCommandId === prepared.initialCommandId,
  );
  const guide = current.state.inputs?.find(
    (input) => input.intent.sourceCommandId === prepared.guideCommandId,
  );
  if (!initial || !guide) throw new Error("同Run的原canonical A/guide B缺失。");
  // dispatch随Run自然结束转drained；冻结选择、原mode/plan与用户正文不改写。
  expect(initial.intent).toEqual({
    ...prepared.frozenA.intent,
    dispatch: initial.intent.dispatch,
  });
  expect(initial.modelInvocation).toEqual(prepared.frozenA.modelInvocation);
  expect(guide).toMatchObject({
    runId: prepared.first.runId,
    status: "settled",
    scopeGeneration: Number(prepared.original.scope_generation),
    branchGeneration: Number(prepared.original.branch_generation),
    intent: {
      modelSelection: prepared.selected,
      mode: "plan",
      planEnabled: false,
      delivery: { requested: "auto", admitted: "guide" },
      steer: { state: "guided" },
    },
  });
  expect(guide.modelInvocation).toEqual(prepared.frozenA.modelInvocation);
  const value = await snapshot(host);
  expect(value.config).toMatchObject({ mode: "plan", planEnabled: false });
  const guided = value.rows.window.find(
    (row) =>
      row.kind === "userInput" &&
      row.sourceCommandId === prepared.guideCommandId,
  );
  if (guided?.kind !== "userInput" || !guided.entityId)
    throw new Error("plan指导缺少稳定用户行ID。");
  expect(guided).toMatchObject({
    guided: true,
    turnId: prepared.first.runId,
    text: GUIDE_TEXT,
  });
  return guided.entityId;
}

function assertActualWriteError(model: Model) {
  const third = model.requests[2]?.body;
  if (!third) throw new Error("真实Write管线没有回到C模型请求。");
  const call = third.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .find((entry) => entry.id === GUIDE_MODE_WRITE_CALL);
  if (!call) throw new Error("C请求缺少B实际发起的原Write调用。");
  expect(call.function.name).toBe("Write");
  expect(JSON.parse(call.function.arguments)).toEqual({
    file_path: GUIDE_MODE_FILE,
    content: GUIDE_MODE_FILE_CONTENT,
  });
  const results = third.messages.filter(
    (message) =>
      message.role === "tool" && message.tool_call_id === GUIDE_MODE_WRITE_CALL,
  );
  expect(results).toHaveLength(1);
  expect(JSON.stringify(results[0]?.content)).toMatch(
    /plan|只读|拒绝|权限|permission|denied/i,
  );
  expect(third.messages).toContainEqual(
    expect.objectContaining({ role: "user", content: GUIDE_TEXT }),
  );
  expect(JSON.stringify(third.messages).split(GUIDE_TEXT)).toHaveLength(2);
}

async function assertErrorToolFact(
  fixture: Fixture,
  host: Host,
  runId: string,
) {
  const value = await snapshot(host);
  const tools = value.rows.window.filter(
    (row) => row.kind === "toolCall" && row.toolName === "Write",
  );
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({
    status: "error",
    input: { file_path: GUIDE_MODE_FILE, content: GUIDE_MODE_FILE_CONTENT },
  });
  const facts = await createCodeUiRepository(
    fixture.database.persistence,
  ).readToolCompletions(fixture.actor.instanceId, host.sessionId, runId, {
    maxEvents: 10,
    maxBytes: 10000,
  });
  expect(facts).toContainEqual(
    expect.objectContaining({
      runId,
      toolName: "Write",
      toolCallId: GUIDE_MODE_WRITE_CALL,
      status: "error",
    }),
  );
}

async function assertNativeModePost(
  fixture: Fixture,
  host: Host,
  runId: string,
  guideId: string,
) {
  const boundaries = await fixture.app.kernel
    .get("agentRunMetadata")
    .getOwnedTurnBoundaries(fixture.actor, { taskId: host.sessionId, runId });
  const reference = boundaries.post?.context;
  if (reference?.status !== "captured" || !reference.reference)
    throw new Error("自然结束没有实际native post。");
  const native = decodeNativeContextReference(reference.reference);
  const persistence = await fixture.app.kernel
    .get("agentPersistence")
    .getPersistence();
  if (!persistence) throw new Error("native上下文消费者未装配。");
  const checkpoint = await persistence.checkpointer.get({
    configurable: {
      thread_id: native.threadId,
      checkpoint_ns: native.namespace,
      checkpoint_id: native.checkpointId,
    },
  });
  const messages = checkpoint?.channel_values.messages;
  if (!Array.isArray(messages)) throw new Error("native持久消息缺失。");
  expect(
    messages
      .filter(HumanMessage.isInstance)
      .filter(
        (message) => message.id === guideId && message.content === GUIDE_TEXT,
      ),
  ).toHaveLength(1);
  const writeCalls = messages
    .filter(AIMessage.isInstance)
    .flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.id === GUIDE_MODE_WRITE_CALL);
  expect(writeCalls).toEqual([
    expect.objectContaining({
      name: "Write",
      args: { file_path: GUIDE_MODE_FILE, content: GUIDE_MODE_FILE_CONTENT },
    }),
  ]);
  const errors = messages
    .filter(ToolMessage.isInstance)
    .filter((message) => message.tool_call_id === GUIDE_MODE_WRITE_CALL);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.status).toBe("error");
  expect(JSON.stringify(errors[0]?.content)).toMatch(
    /plan|只读|拒绝|权限|permission|denied/i,
  );
  expect(messages.filter(AIMessage.isInstance)).toContainEqual(
    expect.objectContaining({ content: GUIDE_MODE_C_TEXT }),
  );
}

async function admitYoloRestore(
  fixture: Fixture,
  host: Host,
  model: Model,
  prepared: Awaited<ReturnType<typeof prepareModeGuide>>,
) {
  const commandId = randomUUID();
  const payload = {
    text: RESTORE_GUIDE_TEXT,
    modelSelection: prepared.selected,
    mode: "yolo",
    planEnabled: false,
  };
  const accepted = await host.command("sendText", payload, commandId);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(accepted.body.result);
  expect(ack).toMatchObject({
    status: "accepted",
    result: { type: "inputAccepted", delivery: "queue", inputId: commandId },
  });
  const pending = await task(fixture, host);
  assertTaskUnchanged(
    pending,
    prepared.original,
    fixture,
    prepared.first.runId,
  );
  expect(
    pending.state.inputs?.find(
      (input) => input.intent.sourceCommandId === commandId,
    ),
  ).toMatchObject({
    runId: prepared.first.runId,
    status: "queued",
    intent: {
      modelSelection: prepared.selected,
      mode: "yolo",
      planEnabled: false,
      delivery: { requested: "auto", admitted: "guide" },
      steer: { state: "steering" },
    },
  });
  const held = await snapshot(host);
  // 下一边界的yolo指导不能提前解除当前B的plan限制。
  expect(held.config).toMatchObject({ mode: "plan", planEnabled: false });
  expect(held.queue.items).toContainEqual(
    expect.objectContaining({
      sourceCommandId: commandId,
      steer: { state: "steering" },
    }),
  );
  expect(model.requests).toHaveLength(2);
  expect(model.requests[1]?.closed).toBe(false);
  const repeated = await host.command("sendText", payload, commandId);
  expect(protocol.commandAckSchema.parse(repeated.body.result)).toEqual({
    ...ack,
    status: "duplicate",
  });
  return commandId;
}

async function assertRestoredCycleState(
  fixture: Fixture,
  host: Host,
  prepared: Awaited<ReturnType<typeof prepareModeGuide>>,
  restoreCommandId: string,
  planGuideId: string,
  activeRunId: string | null,
) {
  const current = await task(fixture, host);
  assertTaskUnchanged(current, prepared.original, fixture, activeRunId);
  expect(await runIds(fixture, host)).toEqual([prepared.first.runId]);
  const initial = current.state.inputs?.find(
    (input) => input.intent.sourceCommandId === prepared.initialCommandId,
  );
  if (!initial) throw new Error("折返后原A canonical输入缺失。");
  expect(initial.intent).toEqual({
    ...prepared.frozenA.intent,
    dispatch: initial.intent.dispatch,
  });
  expect(initial.modelInvocation).toEqual(prepared.frozenA.modelInvocation);
  const commands = [prepared.guideCommandId, restoreCommandId];
  for (const [index, commandId] of commands.entries())
    expect(
      current.state.inputs?.find(
        (input) => input.intent.sourceCommandId === commandId,
      ),
    ).toMatchObject({
      runId: prepared.first.runId,
      status: "settled",
      modelInvocation: prepared.frozenA.modelInvocation,
      scopeGeneration: Number(prepared.original.scope_generation),
      branchGeneration: Number(prepared.original.branch_generation),
      intent: {
        modelSelection: prepared.selected,
        mode: index === 0 ? "plan" : "yolo",
        planEnabled: false,
        delivery: { requested: "auto", admitted: "guide" },
        steer: { state: "guided" },
      },
    });
  const value = await snapshot(host);
  expect(value.config).toMatchObject({ mode: "yolo", planEnabled: false });
  expect(value.queue.items).toEqual([]);
  const ids: string[] = [];
  for (const [index, commandId] of commands.entries()) {
    const row = value.rows.window.find(
      (entry) =>
        entry.kind === "userInput" && entry.sourceCommandId === commandId,
    );
    if (row?.kind !== "userInput" || !row.entityId)
      throw new Error("折返指导缺少稳定guided用户行。");
    expect(row).toMatchObject({
      turnId: prepared.first.runId,
      guided: true,
      clientId: host.clientId,
      text: index === 0 ? GUIDE_TEXT : RESTORE_GUIDE_TEXT,
    });
    ids.push(row.entityId);
  }
  expect(ids[0]).toBe(planGuideId);
  expect(new Set(ids).size).toBe(2);
  return ids;
}

async function assertCycleSuccessFacts(
  fixture: Fixture,
  host: Host,
  model: Model,
  runId: string,
) {
  const fourth = model.requests[3]?.body;
  if (!fourth) throw new Error("真实恢复Write未回到D模型请求。");
  const call = fourth.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .find((entry) => entry.id === GUIDE_MODE_SUCCESS_CALL);
  if (!call) throw new Error("D缺少C实际发出的新Write调用。");
  expect(call.function.name).toBe("Write");
  expect(JSON.parse(call.function.arguments)).toEqual({
    file_path: GUIDE_MODE_FILE,
    content: GUIDE_MODE_SUCCESS_CONTENT,
  });
  const success = fourth.messages.filter(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id === GUIDE_MODE_SUCCESS_CALL,
  );
  expect(success).toHaveLength(1);
  expect(JSON.stringify(success[0]?.content)).toContain(GUIDE_MODE_FILE);
  expect(
    await readFile(join(host.workspacePath, GUIDE_MODE_FILE), "utf8"),
  ).toBe(GUIDE_MODE_SUCCESS_CONTENT);
  const value = await snapshot(host);
  const tools = value.rows.window.filter(
    (row) => row.kind === "toolCall" && row.toolName === "Write",
  );
  expect(tools).toHaveLength(2);
  expect(tools).toMatchObject([
    {
      status: "error",
      input: { file_path: GUIDE_MODE_FILE, content: GUIDE_MODE_FILE_CONTENT },
    },
    {
      status: "success",
      input: {
        file_path: GUIDE_MODE_FILE,
        content: GUIDE_MODE_SUCCESS_CONTENT,
      },
    },
  ]);
  const facts = await createCodeUiRepository(
    fixture.database.persistence,
  ).readToolCompletions(fixture.actor.instanceId, host.sessionId, runId, {
    maxEvents: 10,
    maxBytes: 10000,
  });
  const writes = facts.filter((event) => event.toolName === "Write");
  expect(writes).toHaveLength(2);
  expect(writes).toMatchObject([
    { runId, toolCallId: GUIDE_MODE_WRITE_CALL, status: "error" },
    { runId, toolCallId: GUIDE_MODE_SUCCESS_CALL, status: "success" },
  ]);
}

async function assertCycleNativePost(
  fixture: Fixture,
  host: Host,
  runId: string,
  guideIds: readonly string[],
) {
  const boundaries = await fixture.app.kernel
    .get("agentRunMetadata")
    .getOwnedTurnBoundaries(fixture.actor, { taskId: host.sessionId, runId });
  const reference = boundaries.post?.context;
  if (reference?.status !== "captured" || !reference.reference)
    throw new Error("折返自然完成没有native post。");
  const native = decodeNativeContextReference(reference.reference);
  const persistence = await fixture.app.kernel
    .get("agentPersistence")
    .getPersistence();
  if (!persistence) throw new Error("折返native persistence未装配。");
  const checkpoint = await persistence.checkpointer.get({
    configurable: {
      thread_id: native.threadId,
      checkpoint_ns: native.namespace,
      checkpoint_id: native.checkpointId,
    },
  });
  const messages = checkpoint?.channel_values.messages;
  if (!Array.isArray(messages)) throw new Error("折返native消息缺失。");
  for (const [index, id] of guideIds.entries())
    expect(
      messages
        .filter(HumanMessage.isInstance)
        .filter(
          (message) =>
            message.id === id &&
            message.content === [GUIDE_TEXT, RESTORE_GUIDE_TEXT][index],
        ),
    ).toHaveLength(1);
  const toolMessages = messages.filter(ToolMessage.isInstance);
  expect(
    toolMessages.filter(
      (message) => message.tool_call_id === GUIDE_MODE_WRITE_CALL,
    ),
  ).toEqual([expect.objectContaining({ status: "error" })]);
  expect(
    toolMessages.filter(
      (message) => message.tool_call_id === GUIDE_MODE_SUCCESS_CALL,
    ),
  ).toEqual([expect.objectContaining({ status: "success" })]);
  expect(messages.filter(AIMessage.isInstance)).toContainEqual(
    expect.objectContaining({ content: GUIDE_MODE_D_TEXT }),
  );
}

async function withModeFixture(
  cycle: boolean,
  scenario: (fixture: Fixture, host: Host, model: Model) => Promise<void>,
) {
  const model = await guideModeFixture({ cycle });
  let fixture: Fixture | undefined;
  let host: Host | undefined;
  try {
    fixture = await createCodeUiHttpFixture();
    host = await createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
    });
    await scenario(fixture, host, model);
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

async function waitForSseClosure(
  model: Model,
  expectedClosed: readonly boolean[],
) {
  await vi.waitFor(
    () =>
      expect(model.requests.map((request) => request.closed)).toEqual(
        expectedClosed,
      ),
    { timeout: 30_000 },
  );
}

async function finishAndWaitForCompletion(
  host: Host,
  model: Model,
  index: number,
) {
  model.finish(index);
  const current = host;
  return vi.waitFor(
    async () => {
      const value = await snapshot(current);
      expect(value.control).toMatchObject({
        phase: "completedSuccess",
        canStop: false,
        activeWorks: [],
      });
      expect(value.pendingInteractions).toEqual([]);
      expect(value.queue.items).toEqual([]);
      return value;
    },
    { timeout: 30_000 },
  );
}

async function assertCycleFinalFacts(
  fixture: Fixture,
  host: Host,
  model: Model,
  prepared: Awaited<ReturnType<typeof prepareModeGuide>>,
  restoreCommandId: string,
  planGuideId: string,
  guideIds: readonly string[],
  ended: protocol.ConversationSnapshot,
) {
  expect(
    await assertRestoredCycleState(
      fixture,
      host,
      prepared,
      restoreCommandId,
      planGuideId,
      null,
    ),
  ).toEqual(guideIds);
  const headers = ended.rows.window.filter((row) => row.kind === "turnHeader");
  expect(headers).toHaveLength(1);
  const header = headers[0];
  if (header?.kind !== "turnHeader")
    throw new Error("折返缺少原Run turnHeader。");
  expect(header).toMatchObject({
    turnId: prepared.first.runId,
    state: "completedSuccess",
  });
  expect(header.workSegments).toHaveLength(3);
  expect(
    header.workSegments?.slice(1).map((segment) => segment.triggerEntityId),
  ).toEqual(guideIds);
  expect(
    ended.rows.window.filter((row) => row.kind === "userInput" && row.guided),
  ).toHaveLength(2);
  expect(
    ended.rows.window
      .filter((row) => row.kind === "assistantText")
      .map((row) => ({
        turnId: row.turnId,
        text: row.text,
        state: row.state,
      })),
  ).toEqual(
    model.texts.map((text) => ({
      turnId: prepared.first.runId,
      text,
      state: "complete",
    })),
  );
  await assertCycleNativePost(fixture, host, prepared.first.runId, guideIds);
  await assertCycleSuccessFacts(fixture, host, model, prepared.first.runId);
  expect(await runIds(fixture, host)).toEqual([prepared.first.runId]);
  expect(model.requests.map((request) => request.body.model)).toEqual([
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
  ]);
}

async function runPlanGuideScenario(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const prepared = await prepareModeGuide(fixture, host, model);
  model.finish(0);
  const second = await waitForPartial(host, model, 1);
  // 先硬验证实际B仍属于原Run，再将之后的策略错误归为guide RED。
  expect(second.runId, "mode guide不得退回新Run执行。").toBe(
    prepared.first.runId,
  );
  assertPolicyPrompt(model, 1, "plan");
  const guideId = await assertGuidedMode(
    fixture,
    host,
    prepared,
    prepared.first.runId,
  );
  model.finish(1);
  const third = await waitForPartial(host, model, 2);
  expect(third.runId).toBe(prepared.first.runId);
  assertPolicyPrompt(model, 2, "plan");
  assertActualWriteError(model);
  expect(
    await assertGuidedMode(fixture, host, prepared, prepared.first.runId),
  ).toBe(guideId);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await assertErrorToolFact(fixture, host, prepared.first.runId);
  const ended = await finishAndWaitForCompletion(host, model, 2);
  const headers = ended.rows.window.filter((row) => row.kind === "turnHeader");
  expect(headers).toHaveLength(1);
  expect(headers[0]).toMatchObject({
    turnId: prepared.first.runId,
    state: "completedSuccess",
  });
  expect(await assertGuidedMode(fixture, host, prepared, null)).toBe(guideId);
  await assertNativeModePost(fixture, host, prepared.first.runId, guideId);
  await assertErrorToolFact(fixture, host, prepared.first.runId);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(model.requests.map((request) => request.body.model)).toEqual([
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
  ]);
  expect(await runIds(fixture, host)).toEqual([prepared.first.runId]);
  await waitForSseClosure(model, [true, true, true]);
}

async function runModeCycleScenario(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const prepared = await prepareModeGuide(fixture, host, model);
  model.finish(0);
  const second = await waitForPartial(host, model, 1);
  expect(second.runId).toBe(prepared.first.runId);
  assertPolicyPrompt(model, 1, "plan");
  const planGuideId = await assertGuidedMode(
    fixture,
    host,
    prepared,
    prepared.first.runId,
  );
  // yolo只入下一模型边界的guide队列；此时B当前policy必须仍为plan。
  const restoreCommandId = await admitYoloRestore(
    fixture,
    host,
    model,
    prepared,
  );
  model.finish(1);
  const third = await waitForPartial(host, model, 2);
  expect(third.runId).toBe(prepared.first.runId);
  assertActualWriteError(model);
  await assertErrorToolFact(fixture, host, prepared.first.runId);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  assertPolicyPrompt(model, 2, "yolo");
  const guideIds = await assertRestoredCycleState(
    fixture,
    host,
    prepared,
    restoreCommandId,
    planGuideId,
    prepared.first.runId,
  );
  expect(model.requests[2]?.body.messages).toContainEqual(
    expect.objectContaining({
      role: "user",
      content: RESTORE_GUIDE_TEXT,
    }),
  );
  model.finish(2);
  const fourth = await waitForPartial(host, model, 3);
  expect(fourth.runId).toBe(prepared.first.runId);
  assertPolicyPrompt(model, 3, "yolo");
  await assertCycleSuccessFacts(fixture, host, model, prepared.first.runId);
  expect(
    await assertRestoredCycleState(
      fixture,
      host,
      prepared,
      restoreCommandId,
      planGuideId,
      prepared.first.runId,
    ),
  ).toEqual(guideIds);
  const ended = await finishAndWaitForCompletion(host, model, 3);
  await assertCycleFinalFacts(
    fixture,
    host,
    model,
    prepared,
    restoreCommandId,
    planGuideId,
    guideIds,
    ended,
  );
  await waitForSseClosure(model, [true, true, true, true]);
}

/** 真实HTTP/PG/Actor/Task/Harness与工具拒绝；外部SSE按原脚本逐次释放。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code同Run mode-only guide integration",
  () => {
    it("yolo正文后guide只切plan模式，恶意Write仍被正式管线拒绝且C同Run自然结束", async () => {
      await withModeFixture(false, runPlanGuideScenario);
    }, 90_000); // 独占HTTP/PG与三段SSE同步期限，非运行时治理值。

    it("同Run yolo→plan→yolo折返，B写入真实拒绝而C新Write真实成功，D自然完成", async () => {
      await withModeFixture(true, runModeCycleScenario);
    }, 90_000); // 独占HTTP/PG与四段真实SSE的测试期限，非运行时治理值。
  },
);
