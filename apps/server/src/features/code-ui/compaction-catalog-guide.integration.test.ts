import { randomUUID } from "node:crypto";
import {
  modelListResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ModelSelection } from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { effectiveNativeMessages } from "../../agent/native-context-history.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  CATALOG_COMPACT_MODEL,
  CATALOG_COMPACT_TURNS,
  catalogCompactionModelFixture,
  catalogModelText,
  catalogReplyText,
  catalogUserText,
} from "./compaction-catalog-metadata.fixture.js";
import {
  assertAutoEvidence,
  assertCatalogNoCanvas,
  assertFullHistory,
  assertOwnedRun,
  declareAndQualify,
  disposeCatalogFixture,
  type Fixture,
  finishRound,
  type Host,
  type Model,
  type Original,
  readCatalogCompactedEvents,
  TEST_CASE_TIMEOUT_MS,
  TEST_SYNC_TIMEOUT_MS,
} from "./compaction-catalog-test.fixture.js";
import {
  assertTaskUnchanged,
  readNativeBoundaryState,
  runIds,
  snapshot,
  task,
} from "./guide-state-test.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";

// 固定模型声明/有限同步预算；不PATCH defaultModel、不覆盖治理阈值。
const ENDPOINT_A = "instance-a";
const ENDPOINT_B = "instance-b";
const A_WINDOW = 120_000;
const A_OUTPUT = 20_000;
const B_WINDOW = 24_000;
const B_OUTPUT = 16_000;
const B_TRIGGER = 8_000;
const ACTIVE_ROUND = CATALOG_COMPACT_TURNS + 1;
const GUIDE_TEXT =
  "CATALOG_COMPACT_GUIDE_B_691a51b3：继续当前轮，使用明确选择的同名实例B。";

type Pair = {
  fixture: Fixture;
  host: Host;
  model: Model;
  original: Original;
  selectionA: ModelSelection;
  selectionB: ModelSelection;
};

async function createProviderB(host: Host, model: Model) {
  const created = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method: "createPersonalProvider",
    args: [{ providerName: "同名模型目录实例B验收" }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const providerId = z.uuid().parse(created.body.result.providerId);
  const configured = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method: "savePersonalProviderOverlay",
    args: [
      providerId,
      {
        api: {
          type: "openai-chat-completions",
          baseUrl: model.baseUrlFor(ENDPOINT_B),
        },
        access: { type: "api-key", apiKey: "integration-only-not-a-key" },
      },
    ],
  });
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  return providerId;
}

async function withPair(
  hold: boolean,
  scenario: (pair: Pair) => Promise<void>,
) {
  const model = await catalogCompactionModelFixture({
    endpointLabels: [ENDPOINT_A, ENDPOINT_B],
    turns: ACTIVE_ROUND,
    ...(hold ? { holdFromRound: ACTIVE_ROUND } : {}),
  });
  let fixture: Fixture | undefined;
  let host: Host | undefined;
  let providerB: string | undefined;
  try {
    fixture = await createCodeUiHttpFixture();
    host = await createCodeSessionFixture(model.baseUrlFor(ENDPOINT_A), {
      client: fixture.client,
    });
    const selectionA = await declareAndQualify(host, {
      contextWindow: A_WINDOW,
      maxOutputTokens: A_OUTPUT,
    });
    providerB = await createProviderB(host, model);
    const selectionB = await declareAndQualify(host, {
      providerId: providerB,
      contextWindow: B_WINDOW,
      maxOutputTokens: B_OUTPUT,
    });
    expect(selectionA.modelId).toBe(CATALOG_COMPACT_MODEL);
    expect(selectionB.modelId).toBe(selectionA.modelId);
    expect(selectionB.providerId).not.toBe(selectionA.providerId);
    await assertPublicPair(host, selectionA, selectionB);
    expect(model.requests, "声明和资格读取不应调用模型。").toEqual([]);
    const original = await task(fixture, host);
    await assertCatalogNoCanvas(fixture, host, original);
    await scenario({ fixture, host, model, original, selectionA, selectionB });
  } finally {
    await disposeCatalogFixture(model, host, fixture, providerB);
  }
}

async function assertPublicPair(
  host: Host,
  selectionA: ModelSelection,
  selectionB: ModelSelection,
) {
  const catalog = await host.client.request("/api/models");
  expect(catalog.status).toBe(200);
  // A先创建作为同名decoy；公开列表确认B没有覆盖A，也不是唯一同名候选。
  expect(
    modelListResponseSchema
      .parse(catalog.body)
      .models.filter((entry) => entry.id.endsWith(`:${CATALOG_COMPACT_MODEL}`)),
  ).toMatchObject([
    {
      id: `${selectionA.providerId}:${CATALOG_COMPACT_MODEL}`,
      contextWindow: A_WINDOW,
      maxOutputTokens: A_OUTPUT,
    },
    {
      id: `${selectionB.providerId}:${CATALOG_COMPACT_MODEL}`,
      contextWindow: B_WINDOW,
      maxOutputTokens: B_OUTPUT,
    },
  ]);
}

async function sendInput(
  host: Host,
  selection: ModelSelection,
  text: string,
  commandId = randomUUID(),
) {
  const payload = {
    text,
    modelSelection: selection,
    mode: "build",
    planEnabled: false,
  } as const;
  const response = await host.command("sendText", payload, commandId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(response.body.result);
  expect(ack.status).toBe("accepted");
  return { commandId, payload, ack };
}

async function warmup(pair: Pair, selection: ModelSelection, endpoint: string) {
  const commandIds: string[] = [];
  const completedRunIds: string[] = [];
  for (let round = 1; round <= CATALOG_COMPACT_TURNS; round++) {
    const sent = await sendInput(pair.host, selection, catalogUserText(round));
    commandIds.push(sent.commandId);
    const runId = await finishRound(pair.host, sent.commandId, round, endpoint);
    completedRunIds.push(runId);
    await assertOwnedRun(
      pair.fixture,
      pair.host,
      pair.original,
      runId,
      sent.commandId,
      selection,
    );
  }
  expect(new Set(completedRunIds).size).toBe(CATALOG_COMPACT_TURNS);
  return { commandIds, completedRunIds };
}

async function waitForHeldNormal(pair: Pair, endpoint: string) {
  return vi.waitFor(
    async () => {
      const observed = pair.model.requests.find(
        (request) =>
          request.kind === "normal" &&
          request.endpoint === endpoint &&
          request.round === ACTIVE_ROUND &&
          !request.closed,
      );
      if (!observed) throw new Error("指定实例的真实普通SSE尚未打开。");
      const active = await snapshot(pair.host);
      expect(active.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          text: catalogReplyText(ACTIVE_ROUND, endpoint),
          state: "streaming",
        }),
      );
      const primary = active.control.activeWorks.filter(
        (work) => work.kind === "primaryTurn",
      );
      expect(primary).toHaveLength(1);
      const runId = primary[0]?.foregroundExecutionId;
      if (!runId) throw new Error("实际正文流缺少原Run身份。");
      assertTaskUnchanged(
        await task(pair.fixture, pair.host),
        pair.original,
        pair.fixture,
        runId,
      );
      return { observed, active, runId };
    },
    { timeout: TEST_SYNC_TIMEOUT_MS },
  );
}

async function freezeInput(
  pair: Pair,
  commandId: string,
  selection: ModelSelection,
) {
  const current = await task(pair.fixture, pair.host);
  const input = current.state.inputs?.find(
    (value) => value.intent.sourceCommandId === commandId,
  );
  if (!input) throw new Error("真实canonical输入缺失。");
  expect(input.intent.modelSelection).toEqual(selection);
  expect(input.modelInvocation).toMatchObject({
    providerId: selection.providerId,
    modelId: selection.modelId,
    configRevision: expect.any(Number),
  });
  expect(input).toMatchObject({
    scopeGeneration: Number(pair.original.scope_generation),
    branchGeneration: Number(pair.original.branch_generation),
    intent: { clientId: pair.host.clientId, kind: "sendText" },
  });
  return structuredClone(input.modelInvocation);
}

async function admitGuide(
  pair: Pair,
  first: Awaited<ReturnType<typeof waitForHeldNormal>>,
) {
  const configured = await pair.host.command(
    "setFollowupMode",
    { mode: "guide" },
    randomUUID(),
    {
      baseRevision: first.active.revision,
      baseLogEpoch: first.active.logEpoch,
    },
  );
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  expect((await snapshot(pair.host)).config.followupMode).toBe("guide");
  const sent = await sendInput(pair.host, pair.selectionB, GUIDE_TEXT);
  expect(sent.ack).toMatchObject({
    result: {
      type: "inputAccepted",
      delivery: "queue",
      inputId: sent.commandId,
    },
  });
  const frozenB = await freezeInput(pair, sent.commandId, pair.selectionB);
  const beforeReplay = pair.model.requests.length;
  const replay = await pair.host.command(
    "sendText",
    sent.payload,
    sent.commandId,
  );
  expect(protocol.commandAckSchema.parse(replay.body.result)).toEqual({
    ...sent.ack,
    status: "duplicate",
  });
  expect(pair.model.requests).toHaveLength(beforeReplay);
  expect(first.observed.closed).toBe(false);
  return { ...sent, frozenB };
}

async function assertGuidedNativeHistory(
  pair: Pair,
  runId: string,
  commandIds: string[],
  guideCommandId: string,
) {
  const post = await readNativeBoundaryState(
    pair.fixture,
    pair.host,
    runId,
    "post",
  );
  const messages = post.state.messages;
  if (!Array.isArray(messages))
    throw new Error("原Run没有真实native post历史。");
  const texts = [
    ...commandIds.map((_, index) => catalogUserText(index + 1)),
    GUIDE_TEXT,
  ];
  for (const text of texts)
    expect(
      messages
        .filter(HumanMessage.isInstance)
        .filter((value) => value.content === text),
    ).toHaveLength(1);
  for (const request of pair.model.requests.filter(
    (value) => value.kind === "normal",
  ))
    expect(
      messages
        .filter(AIMessage.isInstance)
        .some((value) => value.content === request.reply),
    ).toBe(true);
  const summary = pair.model.requests.find((value) => value.kind === "summary");
  if (!summary) throw new Error("原SDK未向实际所选B端点请求摘要。");
  const effective = effectiveNativeMessages(messages, post.state);
  expect(effective.length).toBeLessThan(messages.length);
  expect(
    effective
      .filter(HumanMessage.isInstance)
      .filter((value) => value.additional_kwargs.lc_source === "summarization"),
  ).toHaveLength(1);
  expect(JSON.stringify(effective[0]?.content)).toContain(summary.reply);
  expect(JSON.stringify(effective.map((value) => value.content))).not.toContain(
    "CATALOG_COMPACT_USER_1_381dfc02",
  );
  const ended = await snapshot(pair.host);
  const transcript = ended.rows.window
    .filter((row) => row.kind === "userInput")
    .filter((row) => row.origin === "realUser");
  expect(transcript).toHaveLength(texts.length);
  for (const [index, commandId] of [...commandIds, guideCommandId].entries())
    expect(transcript).toContainEqual(
      expect.objectContaining({
        sourceCommandId: commandId,
        text: texts[index],
      }),
    );
  const guided = transcript.find(
    (row) => row.sourceCommandId === guideCommandId,
  );
  if (guided?.kind !== "userInput" || !guided.entityId)
    throw new Error("同Run指导缺少真实转录实体。");
  expect(guided).toMatchObject({
    guided: true,
    turnId: runId,
    clientId: pair.host.clientId,
  });
  expect(
    messages
      .filter(HumanMessage.isInstance)
      .filter(
        (value) => value.id === guided.entityId && value.content === GUIDE_TEXT,
      ),
  ).toHaveLength(1);
  expect((await task(pair.fixture, pair.host)).state.inputs).toHaveLength(
    texts.length,
  );
  await assertCatalogNoCanvas(pair.fixture, pair.host, pair.original);
}

async function assertGuideCompleted(
  pair: Pair,
  previous: Awaited<ReturnType<typeof warmup>>,
  initial: Awaited<ReturnType<typeof sendInput>>,
  guide: Awaited<ReturnType<typeof admitGuide>>,
  frozenA: Awaited<ReturnType<typeof freezeInput>>,
  runId: string,
) {
  await assertOwnedRun(
    pair.fixture,
    pair.host,
    pair.original,
    runId,
    initial.commandId,
    pair.selectionA,
  );
  expect(await freezeInput(pair, initial.commandId, pair.selectionA)).toEqual(
    frozenA,
  );
  expect(await freezeInput(pair, guide.commandId, pair.selectionB)).toEqual(
    guide.frozenB,
  );
  const current = await task(pair.fixture, pair.host);
  const guided = current.state.inputs?.find(
    (value) => value.intent.sourceCommandId === guide.commandId,
  );
  expect(guided).toMatchObject({
    runId,
    status: "settled",
    intent: {
      delivery: { requested: "auto", admitted: "guide" },
      steer: { state: "guided" },
    },
  });
  expect(new Set(await runIds(pair.fixture, pair.host))).toEqual(
    new Set([...previous.completedRunIds, runId]),
  );
  await assertAutoEvidence(pair.fixture, pair.host, pair.model, [runId], {
    triggerTokens: B_TRIGGER,
    endpoint: ENDPOINT_B,
  });
  expect(
    await readCatalogCompactedEvents(pair.fixture, pair.host),
  ).toHaveLength(1);
  expect(
    pair.model.requests.filter((value) => value.kind === "summary"),
  ).toHaveLength(1);
  await assertGuidedNativeHistory(
    pair,
    runId,
    [...previous.commandIds, initial.commandId],
    guide.commandId,
  );
  const ended = await snapshot(pair.host);
  const headers = ended.rows.window
    .filter((row) => row.kind === "turnHeader")
    .filter((row) => row.turnId === runId);
  expect(headers).toHaveLength(1);
  expect(headers[0]).toMatchObject({ sourceCommandId: guide.commandId });
  expect(headers[0]?.workSegments).toHaveLength(2);
  const beforeReplay = pair.model.requests.length;
  const replay = await pair.host.command(
    "sendText",
    guide.payload,
    guide.commandId,
  );
  expect(protocol.commandAckSchema.parse(replay.body.result)).toEqual({
    ...guide.ack,
    status: "duplicate",
  });
  expect(pair.model.requests).toHaveLength(beforeReplay);
  const afterReplay = await snapshot(pair.host);
  expect(
    afterReplay.rows.window.find(
      (row) => row.kind === "turnHeader" && row.turnId === runId,
    ),
  ).toEqual(headers[0]);
  assertTaskUnchanged(
    await task(pair.fixture, pair.host),
    pair.original,
    pair.fixture,
    null,
  );
}

/** 两个相同裸modelId、独立端点和不同声明；所有事实由真实公开入口/PG/native产生。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "完整specifier与Guide自动压缩目录 integration",
  () => {
    it(
      "初始显式选同名实例B，预算和真实摘要端点均采用B",
      async () => {
        await withPair(false, async (pair) => {
          const completed = await warmup(pair, pair.selectionB, ENDPOINT_B);
          expect(pair.model.errors).toEqual([]);
          expect(
            pair.model.requests.every(
              (value) =>
                value.endpoint === ENDPOINT_B &&
                value.body.model === CATALOG_COMPACT_MODEL,
            ),
          ).toBe(true);
          await assertAutoEvidence(
            pair.fixture,
            pair.host,
            pair.model,
            completed.completedRunIds,
            { triggerTokens: B_TRIGGER, endpoint: ENDPOINT_B },
          );
          const finalRunId = completed.completedRunIds.at(-1);
          if (!finalRunId) throw new Error("自然历史未产生最后Run。");
          await assertFullHistory(
            pair.fixture,
            pair.host,
            finalRunId,
            completed.commandIds,
            ENDPOINT_B,
          );
        });
      },
      TEST_CASE_TIMEOUT_MS,
    );

    it(
      "A积累真实历史后同Run Guide切同名实例B，阈值8000及native摘要跟随B并保留Scope/Actor/代际",
      async () => {
        await withPair(true, async (pair) => {
          const previous = await warmup(pair, pair.selectionA, ENDPOINT_A);
          expect(
            await readCatalogCompactedEvents(pair.fixture, pair.host),
          ).toEqual([]);
          expect(
            pair.model.requests.every(
              (value) =>
                value.kind === "normal" && value.endpoint === ENDPOINT_A,
            ),
          ).toBe(true);
          const initial = await sendInput(
            pair.host,
            pair.selectionA,
            catalogUserText(ACTIVE_ROUND),
          );
          const first = await waitForHeldNormal(pair, ENDPOINT_A);
          const frozenA = await freezeInput(
            pair,
            initial.commandId,
            pair.selectionA,
          );
          const guide = await admitGuide(pair, first);
          pair.model.finish(first.observed);
          const second = await waitForHeldNormal(pair, ENDPOINT_B);
          expect(second.runId).toBe(first.runId);
          expect(second.observed.body.model).toBe(first.observed.body.model);
          expect(
            second.observed.body.messages.filter(
              (message) =>
                message.role === "user" &&
                catalogModelText(message.content) === GUIDE_TEXT,
            ),
          ).toHaveLength(1);
          expect(
            await freezeInput(pair, initial.commandId, pair.selectionA),
          ).toEqual(frozenA);
          expect(
            await freezeInput(pair, guide.commandId, pair.selectionB),
          ).toEqual(guide.frozenB);
          pair.model.finish(second.observed);
          expect(
            await finishRound(
              pair.host,
              guide.commandId,
              ACTIVE_ROUND,
              ENDPOINT_B,
            ),
          ).toBe(first.runId);
          await assertGuideCompleted(
            pair,
            previous,
            initial,
            guide,
            frozenA,
            first.runId,
          );
          await vi.waitFor(
            () =>
              expect(first.observed.closed && second.observed.closed).toBe(
                true,
              ),
            { timeout: TEST_SYNC_TIMEOUT_MS },
          );
        });
      },
      TEST_CASE_TIMEOUT_MS,
    );
  },
);
