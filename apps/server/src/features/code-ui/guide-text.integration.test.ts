import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { decodeNativeContextReference } from "../../agent/native-context-reference.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCodeUiRepository } from "./repository.js";
import { modelRequestSchema } from "./user-question-model.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;

const INITIAL_TEXT = "保持正文流，等待追加指导后沿当前轮继续。";
const GUIDE_TEXT = "GUIDE_TEXT_BOUNDARY_ONCE_6b07a9c1";
const SECOND_GUIDE_TEXT = "GUIDE_FIFO_SECOND_BOUNDARY_ONCE_87ad35e2";

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

async function waitForPartial(host: Host, model: Model, index: number) {
  // 独占HTTP/数据库同步期限，非Agent运行时限额。
  return vi.waitFor(
    async () => {
      expect(model.requests).toHaveLength(index + 1);
      const active = await snapshot(host);
      expect(active.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          text: `正在运行 ${index + 1}`,
          state: "streaming",
        }),
      );
      expect(active.pendingInteractions).toEqual([]);
      const primary = active.control.activeWorks.filter(
        (work) => work.kind === "primaryTurn",
      );
      expect(primary).toHaveLength(1);
      const runId = primary[0]?.foregroundExecutionId;
      if (!runId) throw new Error("真实正文流缺少活动Run身份。");
      return { active, runId };
    },
    { timeout: 30_000 },
  );
}

function assertTextContinuation(model: Model) {
  expect(model.requests).toHaveLength(2);
  const first = modelRequestSchema.parse(model.requests[0]?.body);
  const second = modelRequestSchema.parse(model.requests[1]?.body);
  expect(JSON.stringify(first.messages)).not.toContain(GUIDE_TEXT);
  expect(second.messages).toContainEqual(
    expect.objectContaining({ role: "assistant", content: "正在运行 1" }),
  );
  expect(second.messages).toContainEqual(
    expect.objectContaining({ role: "user", content: GUIDE_TEXT }),
  );
  expect(JSON.stringify(second.messages).split(GUIDE_TEXT)).toHaveLength(2);
  const firstAssistantIndex = second.messages.findIndex(
    (message) =>
      message.role === "assistant" && message.content === "正在运行 1",
  );
  const guideIndex = second.messages.findIndex(
    (message) => message.role === "user" && message.content === GUIDE_TEXT,
  );
  expect(firstAssistantIndex).toBeLessThan(guideIndex);
  for (const request of [first, second]) {
    expect(
      request.messages.flatMap((message) => message.tool_calls ?? []),
    ).toEqual([]);
    expect(
      request.messages.filter((message) => message.role === "tool"),
    ).toEqual([]);
  }
}

async function waitForCompletion(host: Host) {
  return vi.waitFor(
    async () => {
      const ended = await snapshot(host);
      expect(ended.control).toMatchObject({
        phase: "completedSuccess",
        canStop: false,
        activeWorks: [],
      });
      expect(ended.pendingInteractions).toEqual([]);
      for (const text of ["正在运行 1", "正在运行 2"])
        expect(ended.rows.window).toContainEqual(
          expect.objectContaining({
            kind: "assistantText",
            text,
            state: "complete",
          }),
        );
      return ended;
    },
    { timeout: 30_000 },
  );
}

function assertSameTurn(
  ended: protocol.ConversationSnapshot,
  runId: string,
  initialCommandId: string,
  guideCommandId: string,
  clientId: string,
) {
  const headers = ended.rows.window.filter((row) => row.kind === "turnHeader");
  expect(headers).toHaveLength(1);
  const header = headers[0];
  if (header?.kind !== "turnHeader") throw new Error("原turnHeader缺失。");
  expect(header).toMatchObject({ turnId: runId, state: "completedSuccess" });
  const guided = ended.rows.window.find(
    (row) => row.kind === "userInput" && row.sourceCommandId === guideCommandId,
  );
  if (guided?.kind !== "userInput" || !guided.entityId)
    throw new Error("原guided用户行与native实体身份缺失。");
  expect(guided).toMatchObject({
    turnId: runId,
    text: GUIDE_TEXT,
    guided: true,
    origin: "realUser",
    sourceCommandId: guideCommandId,
    clientId,
  });
  expect(ended.rows.window).toContainEqual(
    expect.objectContaining({
      kind: "userInput",
      text: INITIAL_TEXT,
      sourceCommandId: initialCommandId,
      turnId: runId,
    }),
  );
  expect(
    ended.rows.window
      .filter((row) => row.kind === "assistantText")
      .map((row) => row.turnId),
  ).toEqual([runId, runId]);
  expect(header.workSegments).toHaveLength(2);
  expect(header.workSegments?.[1]).toMatchObject({
    triggerEntityId: guided.entityId,
    endedAt: expect.any(Number),
  });
  return guided.entityId;
}

async function assertNativePost(
  fixture: Fixture,
  host: Host,
  runId: string,
  guideEntityId: string,
) {
  const boundaries = await fixture.app.kernel
    .get("agentRunMetadata")
    .getOwnedTurnBoundaries(fixture.actor, { taskId: host.sessionId, runId });
  const reference = boundaries.post?.context;
  if (reference?.status !== "captured" || !reference.reference)
    throw new Error("原Run自然完成后没有持久native post引用。");
  const native = decodeNativeContextReference(reference.reference);
  const persistence = await fixture.app.kernel
    .get("agentPersistence")
    .getPersistence();
  if (!persistence) throw new Error("真实native post消费者缺失。");
  const checkpoint = await persistence.checkpointer.get({
    configurable: {
      thread_id: native.threadId,
      checkpoint_ns: native.namespace,
      checkpoint_id: native.checkpointId,
    },
  });
  expect(checkpoint?.channel_values.messages).toContainEqual(
    expect.objectContaining({ id: guideEntityId, content: GUIDE_TEXT }),
  );
  for (const content of ["正在运行 1", "正在运行 2"])
    expect(checkpoint?.channel_values.messages).toContainEqual(
      expect.objectContaining({ content }),
    );
}

async function prepareGuideAdmission(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const initial = await snapshot(host);
  const submission = {
    modelSelection: initial.config.modelSelection,
    mode: initial.config.mode,
    planEnabled: initial.config.planEnabled,
  };
  const initialCommandId = randomUUID();
  const sent = await host.command(
    "sendText",
    { text: INITIAL_TEXT, ...submission },
    initialCommandId,
  );
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  const first = await waitForPartial(host, model, 0);
  const original = await task(fixture, host);
  expect(original.active_run_id).toBe(first.runId);
  expect(await runIds(fixture, host)).toEqual([first.runId]);
  const configured = await host.command(
    "setFollowupMode",
    { mode: "guide" },
    randomUUID(),
    {
      baseRevision: first.active.revision,
      baseLogEpoch: first.active.logEpoch,
    },
  );
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(configured.body.result).status).toBe(
    "accepted",
  );
  const routing = await snapshot(host);
  expect(routing.config.followupMode).toBe("guide");
  const guideCommandId = randomUUID();
  // 普通SessionPane仅显式选立即发送时带requestedDelivery；guide由宿主配置裁决。
  const accepted = await host.command(
    "sendText",
    { text: GUIDE_TEXT, ...submission },
    guideCommandId,
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(accepted.body.result)).toMatchObject({
    status: "accepted",
    result: {
      type: "inputAccepted",
      delivery: "queue",
      inputId: guideCommandId,
    },
  });
  const admission = await task(fixture, host);
  expect(admission.active_run_id).toBe(first.runId);
  expect(admission.scope_generation).toBe(original.scope_generation);
  expect(admission.branch_generation).toBe(original.branch_generation);
  return {
    first,
    original,
    routing,
    admission,
    initialCommandId,
    guideCommandId,
  };
}

function assertFifoTask(
  current: Awaited<ReturnType<typeof task>>,
  original: Awaited<ReturnType<typeof task>>,
  activeRunId: string | null,
) {
  expect(current).toMatchObject({
    id: original.id,
    instance_id: original.instance_id,
    project_id: original.project_id,
    root_directory: original.root_directory,
    additional_directories: original.additional_directories,
    scope_generation: original.scope_generation,
    branch_generation: original.branch_generation,
    execution_state: "ready",
    active_run_id: activeRunId,
  });
}

async function assertFifoAdmission(
  fixture: Fixture,
  host: Host,
  original: Awaited<ReturnType<typeof task>>,
  runId: string,
  commands: readonly [string, string],
  consumed: 0 | 1 | 2,
  activeRunId: string | null,
) {
  const current = await task(fixture, host);
  assertFifoTask(current, original, activeRunId);
  expect(current.state.runId).toBe(runId);
  expect(await runIds(fixture, host)).toEqual([runId]);
  for (const [index, commandId] of commands.entries()) {
    const promoted = index < consumed;
    expect(
      current.state.inputs?.find(
        (input) => input.intent.sourceCommandId === commandId,
      ),
    ).toMatchObject({
      status: promoted ? "settled" : "queued",
      runId,
      scopeGeneration: Number(original.scope_generation),
      branchGeneration: Number(original.branch_generation),
      intent: {
        delivery: { requested: "auto", admitted: "guide" },
        steer: { state: promoted ? "guided" : "steering" },
        ...(promoted ? { dispatch: { state: "drained" } } : {}),
      },
    });
  }
  const currentSnapshot = await snapshot(host);
  const queued = currentSnapshot.queue.items.filter((item) =>
    commands.includes(item.sourceCommandId ?? ""),
  );
  expect(queued.map((item) => item.sourceCommandId)).toEqual(
    commands.slice(consumed),
  );
  for (const item of queued)
    expect(item).toMatchObject({
      delivery: { requested: "auto", admitted: "guide" },
      steer: { state: "steering" },
    });
  const ids: string[] = [];
  for (const [index, commandId] of commands.slice(0, consumed).entries()) {
    const row = currentSnapshot.rows.window.find(
      (entry) =>
        entry.kind === "userInput" && entry.sourceCommandId === commandId,
    );
    if (row?.kind !== "userInput" || !row.entityId)
      throw new Error("已提升的 FIFO guide 缺少真实用户行与稳定实体ID。");
    expect(row).toMatchObject({
      guided: true,
      origin: "realUser",
      turnId: runId,
      clientId: host.clientId,
      sourceCommandId: commandId,
      text: [GUIDE_TEXT, SECOND_GUIDE_TEXT][index],
    });
    ids.push(row.entityId);
  }
  expect(
    currentSnapshot.rows.window.filter(
      (row) =>
        row.kind === "userInput" &&
        commands.includes(row.sourceCommandId ?? ""),
    ),
  ).toHaveLength(consumed);
  return ids;
}

function assertFifoModelRequest(model: Model, index: 1 | 2) {
  expect(model.requests).toHaveLength(index + 1);
  const requests = model.requests.map((request) =>
    modelRequestSchema.parse(request.body),
  );
  expect(JSON.stringify(requests[0]?.messages)).not.toContain(GUIDE_TEXT);
  expect(JSON.stringify(requests[0]?.messages)).not.toContain(
    SECOND_GUIDE_TEXT,
  );
  const current = requests[index];
  if (!current) throw new Error("缺少实际 FIFO 后续模型 HTTP 请求。");
  expect(current.messages).toContainEqual(
    expect.objectContaining({ role: "assistant", content: "正在运行 1" }),
  );
  expect(current.messages).toContainEqual(
    expect.objectContaining({ role: "user", content: GUIDE_TEXT }),
  );
  expect(JSON.stringify(current.messages).split(GUIDE_TEXT)).toHaveLength(2);
  const guide1 = current.messages.findIndex(
    (message) => message.role === "user" && message.content === GUIDE_TEXT,
  );
  const assistant1 = current.messages.findIndex(
    (message) =>
      message.role === "assistant" && message.content === "正在运行 1",
  );
  expect(assistant1).toBeLessThan(guide1);
  if (index === 1) {
    // 关键模型边界：第二条不得提前进入 B 的真实请求。
    expect(JSON.stringify(current.messages)).not.toContain(SECOND_GUIDE_TEXT);
  } else {
    expect(current.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "正在运行 2" }),
    );
    expect(current.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: SECOND_GUIDE_TEXT }),
    );
    expect(
      JSON.stringify(current.messages).split(SECOND_GUIDE_TEXT),
    ).toHaveLength(2);
    const assistant2 = current.messages.findIndex(
      (message) =>
        message.role === "assistant" && message.content === "正在运行 2",
    );
    const guide2 = current.messages.findIndex(
      (message) =>
        message.role === "user" && message.content === SECOND_GUIDE_TEXT,
    );
    expect(guide1).toBeLessThan(assistant2);
    expect(assistant2).toBeLessThan(guide2);
  }
  for (const request of requests) {
    expect(
      request.messages.flatMap((message) => message.tool_calls ?? []),
    ).toEqual([]);
    expect(
      request.messages.filter((message) => message.role === "tool"),
    ).toEqual([]);
  }
}

function assertFifoCompletedRows(
  ended: protocol.ConversationSnapshot,
  runId: string,
  initialCommandId: string,
  guideIds: readonly string[],
) {
  expect(guideIds).toHaveLength(2);
  expect(new Set(guideIds).size).toBe(2);
  expect(ended.queue.items).toEqual([]);
  const headers = ended.rows.window.filter((row) => row.kind === "turnHeader");
  expect(headers).toHaveLength(1);
  const header = headers[0];
  if (header?.kind !== "turnHeader")
    throw new Error("FIFO 同轮次缺少原 turnHeader。");
  expect(header).toMatchObject({ turnId: runId, state: "completedSuccess" });
  expect(header.workSegments).toHaveLength(3);
  expect(
    header.workSegments?.slice(1).map((segment) => segment.triggerEntityId),
  ).toEqual(guideIds);
  for (const segment of header.workSegments ?? [])
    expect(segment.endedAt).toEqual(expect.any(Number));
  expect(
    ended.rows.window
      .filter((row) => row.kind === "userInput")
      .map((row) => row.text),
  ).toEqual([INITIAL_TEXT, GUIDE_TEXT, SECOND_GUIDE_TEXT]);
  expect(ended.rows.window).toContainEqual(
    expect.objectContaining({
      kind: "userInput",
      turnId: runId,
      sourceCommandId: initialCommandId,
      text: INITIAL_TEXT,
    }),
  );
  expect(
    ended.rows.window
      .filter((row) => row.kind === "assistantText")
      .map((row) => ({ turnId: row.turnId, text: row.text, state: row.state })),
  ).toEqual([
    { turnId: runId, text: "正在运行 1", state: "complete" },
    { turnId: runId, text: "正在运行 2", state: "complete" },
    { turnId: runId, text: "正在运行 3", state: "complete" },
  ]);
}

async function assertFifoNativePost(
  fixture: Fixture,
  host: Host,
  runId: string,
  guideIds: readonly string[],
) {
  const firstId = guideIds[0];
  if (!firstId) throw new Error("FIFO native 对账缺少第一条 guide 实体ID。");
  await assertNativePost(fixture, host, runId, firstId);
  const boundaries = await fixture.app.kernel
    .get("agentRunMetadata")
    .getOwnedTurnBoundaries(fixture.actor, { taskId: host.sessionId, runId });
  const reference = boundaries.post?.context;
  if (reference?.status !== "captured" || !reference.reference)
    throw new Error("FIFO 自然完成没有真实 native post。");
  const native = decodeNativeContextReference(reference.reference);
  const persistence = await fixture.app.kernel
    .get("agentPersistence")
    .getPersistence();
  if (!persistence) throw new Error("FIFO native persistence 未装配。");
  const checkpoint = await persistence.checkpointer.get({
    configurable: {
      thread_id: native.threadId,
      checkpoint_ns: native.namespace,
      checkpoint_id: native.checkpointId,
    },
  });
  const messages = checkpoint?.channel_values.messages;
  if (!Array.isArray(messages))
    throw new Error("FIFO native post 未保存真实消息。");
  for (const [index, id] of guideIds.entries()) {
    const content = [GUIDE_TEXT, SECOND_GUIDE_TEXT][index];
    expect(messages).toContainEqual(expect.objectContaining({ id, content }));
    expect(messages.filter((message) => message?.id === id)).toHaveLength(1);
    expect(
      messages.filter((message) => message?.content === content),
    ).toHaveLength(1);
  }
  expect(messages).toContainEqual(
    expect.objectContaining({ content: "正在运行 3" }),
  );
}

/** 原SessionPane的followup配置+普通sendText；只有外部模型流由测试显式结束。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code正文边界guide integration",
  () => {
    it("普通UI送法的guide在无工具正文完成后进入同Run下一请求，原轮自然完成并持久保存", async () => {
      const model = await heldModel();
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      try {
        fixture = await createCodeUiHttpFixture();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const {
          first,
          original,
          routing,
          admission,
          initialCommandId,
          guideCommandId,
        } = await prepareGuideAdmission(fixture, host, model);
        model.finish(0);
        const second = await waitForPartial(host, model, 1);
        // 先验证真实模型/Run边界；不能用routing投影先行断言掩盖正文继续运行缺口。
        expect(second.runId).toBe(first.runId);
        expect(await runIds(fixture, host)).toEqual([first.runId]);
        assertTextContinuation(model);
        expect(
          admission.state.inputs?.find(
            (input) => input.intent.sourceCommandId === guideCommandId,
          ),
        ).toMatchObject({
          runId: first.runId,
          scopeGeneration: Number(original.scope_generation),
          branchGeneration: Number(original.branch_generation),
          intent: {
            delivery: { requested: "auto", admitted: "guide" },
            steer: { state: "steering" },
          },
        });
        model.finish(1);
        const ended = await waitForCompletion(host);
        const guideEntityId = assertSameTurn(
          ended,
          first.runId,
          initialCommandId,
          guideCommandId,
          host.clientId,
        );
        const settled = await task(fixture, host);
        expect(settled.active_run_id).toBe(null);
        expect(settled.scope_generation).toBe(original.scope_generation);
        expect(settled.branch_generation).toBe(original.branch_generation);
        expect(await runIds(fixture, host)).toEqual([first.runId]);
        expect(
          settled.state.inputs?.find(
            (input) => input.intent.sourceCommandId === guideCommandId,
          ),
        ).toMatchObject({
          status: "settled",
          runId: first.runId,
          intent: {
            delivery: { requested: "auto", admitted: "guide" },
            steer: { state: "guided" },
            dispatch: { state: "drained" },
          },
        });
        await assertNativePost(fixture, host, first.runId, guideEntityId);
        expect(model.requests).toHaveLength(2);
        expect(routing.inputRouting.mode).toBe("guide");
        expect(second.active.inputRouting.mode).toBe("guide");
      } finally {
        try {
          if (host && (await snapshot(host)).control.activeWorks.length)
            await host.command("stop", {});
        } finally {
          await model.close();
          await host?.dispose();
          await fixture?.close();
        }
      }
    }, 90_000); // 独占HTTP、数据库和模型网络的测试期限，非运行时治理值。

    it("A流式期间追加两条guide，每个模型边界FIFO只提升一条，同Run的B/C顺序继续并自然完成", async () => {
      const model = await heldModel();
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      try {
        fixture = await createCodeUiHttpFixture();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const prepared = await prepareGuideAdmission(fixture, host, model);
        const { first, original, routing, initialCommandId, guideCommandId } =
          prepared;
        expect(original.root_directory).toBe(host.workspacePath);
        expect(model.requests).toHaveLength(1);
        expect(model.requests[0]?.closed).toBe(false);
        const secondCommandId = randomUUID();
        const accepted = await host.command(
          "sendText",
          {
            text: SECOND_GUIDE_TEXT,
            modelSelection: routing.config.modelSelection,
            mode: routing.config.mode,
            planEnabled: routing.config.planEnabled,
          },
          secondCommandId,
        );
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        expect(
          protocol.commandAckSchema.parse(accepted.body.result),
        ).toMatchObject({
          status: "accepted",
          result: {
            type: "inputAccepted",
            delivery: "queue",
            inputId: secondCommandId,
          },
        });
        const commands: readonly [string, string] = [
          guideCommandId,
          secondCommandId,
        ];
        await assertFifoAdmission(
          fixture,
          host,
          original,
          first.runId,
          commands,
          0,
          first.runId,
        );
        expect(model.requests).toHaveLength(1);
        expect(model.requests[0]?.closed).toBe(false);

        model.finish(0);
        const second = await waitForPartial(host, model, 1);
        expect(second.runId).toBe(first.runId);
        assertFifoModelRequest(model, 1);
        const bIds = await assertFifoAdmission(
          fixture,
          host,
          original,
          first.runId,
          commands,
          1,
          first.runId,
        );
        expect(second.active.inputRouting.mode).toBe("guide");

        model.finish(1);
        const third = await waitForPartial(host, model, 2);
        expect(third.runId).toBe(first.runId);
        assertFifoModelRequest(model, 2);
        const cIds = await assertFifoAdmission(
          fixture,
          host,
          original,
          first.runId,
          commands,
          2,
          first.runId,
        );
        expect(cIds[0]).toBe(bIds[0]);
        expect(third.active.inputRouting.mode).toBe("guide");

        model.finish(2);
        const ended = await waitForCompletion(host);
        const finalIds = await assertFifoAdmission(
          fixture,
          host,
          original,
          first.runId,
          commands,
          2,
          null,
        );
        expect(finalIds).toEqual(cIds);
        assertFifoCompletedRows(ended, first.runId, initialCommandId, finalIds);
        await assertFifoNativePost(fixture, host, first.runId, finalIds);
        expect(model.requests).toHaveLength(3);
        await vi.waitFor(
          () =>
            expect(model.requests.map((request) => request.closed)).toEqual([
              true,
              true,
              true,
            ]),
          { timeout: 30_000 },
        );
      } finally {
        try {
          if (host && (await snapshot(host)).control.activeWorks.length)
            await host.command("stop", {});
        } finally {
          try {
            // heldModel.close 实际关闭所有仍打开的SSE连接，RED发生在B时也不会留住模型流。
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
    }, 90_000); // 独占HTTP、PG与三段受控SSE的测试期限，非运行时治理值。
  },
);
