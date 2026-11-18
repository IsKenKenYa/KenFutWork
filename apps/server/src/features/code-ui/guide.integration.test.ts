import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { decodeNativeContextReference } from "../../agent/native-context-reference.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { codeGuideMessageId } from "./input-intents.js";
import { createCodeUiRepository } from "./repository.js";
import {
  questions,
  questionText,
  selectedOption,
  toolCallId,
  userQuestionModel,
} from "./user-question-model.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof userQuestionModel>>;

const GUIDE_SENTINEL = "GUIDE_CURRENT_TURN_ONCE_7cb275d7";
const INITIAL_TEXT = "请先用结构化问题确认运行方式，再根据答案继续。";

async function snapshot(host: Host) {
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

async function task(fixture: Fixture, host: Host) {
  const record = await createCodeUiRepository(
    fixture.database.persistence,
  ).find(fixture.actor.instanceId, host.sessionId);
  if (!record?.state) throw new Error("原HTTP Task与canonical输入未持久化");
  return { ...record, state: record.state };
}

async function waitForQuestion(host: Host) {
  // 独占HTTP/数据库的测试同步期限，非Agent运行时治理值。
  return vi.waitFor(
    async () => {
      const waiting = await snapshot(host);
      const pending = waiting.pendingInteractions.find(
        (interaction) =>
          interaction.kind === "userInput" &&
          interaction.payload.kind === "userInput" &&
          interaction.payload.toolCallId === toolCallId,
      );
      if (!pending) throw new Error("真实AskUserQuestion尚未进入人工等待");
      const primary = waiting.control.activeWorks.filter(
        (work) => work.kind === "primaryTurn",
      );
      expect(primary).toHaveLength(1);
      const runId = primary[0]?.foregroundExecutionId;
      if (!runId) throw new Error("人工等待时原主Run身份缺失");
      return { waiting, pending, runId };
    },
    { timeout: 30_000 },
  );
}

function assertToolContinuation(model: Model) {
  expect(model.requests).toHaveLength(2);
  const request = model.requests[1];
  if (!request) throw new Error("人工答案未释放实际工具并发起下一模型请求");
  const originalCall = request.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .find((call) => call.id === toolCallId);
  if (!originalCall) throw new Error("下一模型请求丢失原AskUserQuestion调用");
  expect(originalCall.function.name).toBe("AskUserQuestion");
  expect(JSON.parse(originalCall.function.arguments)).toEqual({ questions });
  const toolResult = request.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === toolCallId,
  );
  if (!toolResult || typeof toolResult.content !== "string")
    throw new Error("下一模型请求缺少原调用关联的实际ToolMessage");
  expect(JSON.parse(toolResult.content)).toEqual({
    questions,
    answers: { [questionText]: selectedOption },
    annotations: {},
  });
  expect(JSON.stringify(model.requests[0]?.messages)).not.toContain(
    GUIDE_SENTINEL,
  );
  const actualMessages = JSON.stringify(request.messages);
  expect(actualMessages.split(GUIDE_SENTINEL)).toHaveLength(2);
  expect(
    request.messages.filter(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes(GUIDE_SENTINEL),
    ),
  ).toHaveLength(1);
}

function assertGuidedRows(
  completed: protocol.ConversationSnapshot,
  initialCommandId: string,
  guideCommandId: string,
  runId: string,
  clientId: string,
) {
  const inputs = completed.rows.window.filter(
    (row) =>
      row.kind === "userInput" &&
      [initialCommandId, guideCommandId].includes(row.sourceCommandId ?? ""),
  );
  expect(inputs).toHaveLength(2);
  expect(inputs).toContainEqual(
    expect.objectContaining({
      kind: "userInput",
      text: INITIAL_TEXT,
      sourceCommandId: initialCommandId,
      turnId: runId,
    }),
  );
  const guided = inputs.find(
    (row) => row.kind === "userInput" && row.sourceCommandId === guideCommandId,
  );
  if (guided?.kind !== "userInput" || !guided.entityId)
    throw new Error("guide缺少原userInput及其canonical实体身份");
  expect(guided).toMatchObject({
    text: GUIDE_SENTINEL,
    origin: "realUser",
    guided: true,
    sourceCommandId: guideCommandId,
    clientId,
    turnId: runId,
  });
  const headers = completed.rows.window.filter(
    (row) => row.kind === "turnHeader",
  );
  expect(headers).toHaveLength(1);
  const header = headers[0];
  if (header?.kind !== "turnHeader") throw new Error("原轮次头缺失");
  expect(header).toMatchObject({ turnId: runId, state: "completedSuccess" });
  expect(header.workSegments).toHaveLength(2);
  expect(header.workSegments?.[1]).toMatchObject({
    segmentId: guided.entityId,
    triggerEntityId: guided.entityId,
  });
  for (const segment of header.workSegments ?? []) {
    expect(segment.endedAt).toEqual(expect.any(Number));
    // 原契约activeMs可选；没有扣除人工等待的权威时钟时不能用墙钟时间冒充。
    if (segment.activeMs !== undefined)
      expect(segment.activeMs).toBeGreaterThanOrEqual(0);
  }
}

/** 真实HTTP/SSE/独占PG和人工工具等待；只替换外部模型网络边界。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code原guide当前轮继续运行 integration",
  () => {
    it("指导尚未被模型消费时停止原Run，保留canonical并转回暂停队列的新运行身份", async () => {
      const model = await userQuestionModel();
      const fixture = await createCodeUiHttpFixture();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await host.command("sendText", { text: INITIAL_TEXT });
        const { runId } = await waitForQuestion(host);
        const commandId = randomUUID();
        const sent = await host.command(
          "sendText",
          { text: GUIDE_SENTINEL, requestedDelivery: "guide" },
          commandId,
        );
        expect(sent.body.result.status).toBe("accepted");
        const pending = await task(fixture, host);
        expect(
          pending.state.inputs?.find(
            (input) => input.intent.sourceCommandId === commandId,
          ),
        ).toMatchObject({
          runId,
          intent: {
            delivery: { admitted: "guide" },
            steer: { state: "steering" },
          },
        });
        const stopped = await host.command("stop", {
          expectedForegroundExecutionId: runId,
        });
        expect(stopped.body.result.status).toBe("accepted");
        const ended = await task(fixture, host);
        const retained = ended.state.inputs?.find(
          (input) => input.intent.sourceCommandId === commandId,
        );
        if (!retained) throw new Error("未消费指导被停止操作遗失。");
        expect(retained.runId).not.toBe(runId);
        expect(retained).toMatchObject({
          status: "queued",
          intent: {
            text: GUIDE_SENTINEL,
            sourceCommandId: commandId,
            delivery: {
              requested: "guide",
              admitted: "queue",
              fallbackReasonCode: "guide.turnInterrupted",
            },
            steer: { state: "fellBack", reasonCode: "guide.turnInterrupted" },
          },
        });
        const stoppedSnapshot = await snapshot(host);
        expect(stoppedSnapshot.control.phase).toBe("completedInterrupted");
        expect(stoppedSnapshot.queue.autoDrain).toBe(false);
        expect(stoppedSnapshot.pendingInteractions).toEqual([]);
        expect(stoppedSnapshot.queue.items).toContainEqual(
          expect.objectContaining(retained.intent),
        );
        expect(model.requests).toHaveLength(1);
      } finally {
        await model.close();
        await host?.dispose();
        await fixture.close();
      }
    }, 90_000);
    it("工具等待期间guide进入原Run的下一模型请求一次，保持Task两代际并以原guided行和工作段完成", async () => {
      const model = await userQuestionModel();
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      try {
        fixture = await createCodeUiHttpFixture();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const initialCommandId = randomUUID();
        const sent = await host.command(
          "sendText",
          { text: INITIAL_TEXT },
          initialCommandId,
        );
        expect(sent.status, JSON.stringify(sent.body)).toBe(200);
        expect(protocol.commandAckSchema.parse(sent.body.result)).toMatchObject(
          {
            status: "accepted",
            result: { type: "inputAccepted", delivery: "startNow" },
          },
        );
        const { waiting, pending, runId } = await waitForQuestion(host);
        const original = await task(fixture, host);
        expect(original.active_run_id).toBe(runId);
        expect(model.requests).toHaveLength(1);
        expect(
          model.requests[0]?.tools?.map((tool) => tool.function.name),
        ).toContain("AskUserQuestion");

        const guideCommandId = randomUUID();
        const guidePayload = {
          text: GUIDE_SENTINEL,
          requestedDelivery: "guide",
        };
        const accepted = await host.command(
          "sendText",
          guidePayload,
          guideCommandId,
        );
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        // 原ACK的queue是transport接收方式，canonical admitted才裁决guide。
        expect(
          protocol.commandAckSchema.parse(accepted.body.result),
        ).toMatchObject({
          status: "accepted",
          result: {
            type: "inputAccepted",
            delivery: "queue",
            inputId: guideCommandId,
          },
        });
        const steering = await task(fixture, host);
        expect(steering.active_run_id).toBe(runId);
        expect(steering.scope_generation).toBe(original.scope_generation);
        expect(steering.branch_generation).toBe(original.branch_generation);
        const admitted = steering.state.inputs?.find(
          (input) => input.intent.sourceCommandId === guideCommandId,
        );
        if (!admitted) throw new Error("guide的canonical admission未持久化");
        expect(admitted).toMatchObject({
          runId,
          scopeGeneration: Number(original.scope_generation),
          branchGeneration: Number(original.branch_generation),
        });
        expect(admitted.intent.delivery).toEqual({
          requested: "guide",
          admitted: "guide",
        });
        expect(admitted.intent.steer).toEqual({ state: "steering" });
        const afterGuide = await snapshot(host);
        expect(afterGuide.pendingInteractions).toEqual(
          waiting.pendingInteractions,
        );
        expect(
          afterGuide.control.activeWorks.filter(
            (work) => work.kind === "primaryTurn",
          ),
        ).toEqual(
          waiting.control.activeWorks.filter(
            (work) => work.kind === "primaryTurn",
          ),
        );
        expect(
          afterGuide.queue.items.filter(
            (item) => item.sourceCommandId !== guideCommandId,
          ),
        ).toEqual(waiting.queue.items);
        const queuedGuides = afterGuide.queue.items.filter(
          (item) => item.sourceCommandId === guideCommandId,
        );
        expect(queuedGuides.length).toBeLessThanOrEqual(1);
        for (const item of queuedGuides) {
          expect(item.delivery).toEqual(admitted.intent.delivery);
          expect(item.steer).toEqual({ state: "steering" });
        }
        expect(model.requests).toHaveLength(1);

        const resolved = await host.command("resolveInteraction", {
          interactionId: pending.interactionId,
          answer: {
            action: "accept",
            content: {
              answers: { [questionText]: selectedOption },
              annotations: {},
            },
          },
        });
        expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
        expect(
          protocol.commandAckSchema.parse(resolved.body.result).status,
        ).toBe("accepted");
        const current = host;
        await vi.waitFor(
          async () => {
            const completed = await snapshot(current);
            expect(completed.control).toMatchObject({
              phase: "completedSuccess",
              canStop: false,
              activeWorks: [],
            });
            expect(completed.pendingInteractions).toEqual([]);
            expect(completed.rows.window).toContainEqual(
              expect.objectContaining({
                kind: "assistantText",
                text: "已按你的回答继续处理。",
                state: "complete",
              }),
            );
          },
          { timeout: 30_000 },
        );
        assertToolContinuation(model);
        const completed = await snapshot(host);
        // guide的独立pre边界尚未接通；不能错误开放会丢失指导的根输入重试。
        expect(
          completed.rows.window
            .filter((row) => row.kind === "assistantText")
            .at(-1)?.actions?.canRetry,
        ).toBeUndefined();
        assertGuidedRows(
          completed,
          initialCommandId,
          guideCommandId,
          runId,
          host.clientId,
        );
        const settled = await task(fixture, host);
        expect(settled.active_run_id).toBe(null);
        expect(settled.scope_generation).toBe(original.scope_generation);
        expect(settled.branch_generation).toBe(original.branch_generation);
        expect([
          ...new Set(settled.state.inputs?.map((input) => input.runId)),
        ]).toEqual([runId]);
        expect(
          settled.state.inputs?.find(
            (input) => input.intent.sourceCommandId === guideCommandId,
          ),
        ).toMatchObject({
          status: "settled",
          runId,
          intent: {
            delivery: { requested: "guide", admitted: "guide" },
            steer: { state: "guided" },
            dispatch: { state: "drained" },
          },
        });

        const boundaries = await fixture.app.kernel
          .get("agentRunMetadata")
          .getOwnedTurnBoundaries(fixture.actor, {
            taskId: host.sessionId,
            runId,
          });
        const reference = boundaries.post?.context;
        if (reference?.status !== "captured" || !reference.reference)
          throw new Error("同Run完成后未保存真实native post上下文。");
        const native = decodeNativeContextReference(reference.reference);
        const persistence = await fixture.app.kernel
          .get("agentPersistence")
          .getPersistence();
        if (!persistence) throw new Error("真实guide的持久上下文消费者缺失。");
        const checkpoint = await persistence.checkpointer.get({
          configurable: {
            thread_id: native.threadId,
            checkpoint_ns: native.namespace,
            checkpoint_id: native.checkpointId,
          },
        });
        const canonicalGuide = settled.state.inputs?.find(
          (input) => input.intent.sourceCommandId === guideCommandId,
        );
        if (!canonicalGuide)
          throw new Error("已消费guide的canonical归属缺失。");
        expect(checkpoint?.channel_values.messages).toContainEqual(
          expect.objectContaining({
            id: codeGuideMessageId(canonicalGuide),
            content: GUIDE_SENTINEL,
          }),
        );
        const replay = await host.command(
          "sendText",
          guidePayload,
          guideCommandId,
        );
        expect(
          protocol.commandAckSchema.parse(replay.body.result),
        ).toMatchObject({
          status: "duplicate",
          result: {
            type: "inputAccepted",
            delivery: "queue",
            inputId: guideCommandId,
          },
        });
        expect(model.requests).toHaveLength(2);
        expect((await snapshot(host)).rows.window).toEqual(
          completed.rows.window,
        );
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
    }, 90_000); // 独占HTTP、数据库与模型网络的测试期限，非运行时治理值。
  },
);
