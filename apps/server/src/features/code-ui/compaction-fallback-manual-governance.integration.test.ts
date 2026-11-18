import { randomUUID } from "node:crypto";
import {
  codeTaskScopeResponseSchema,
  instanceSettingsResponseSchema,
  zcodeUiProtocol as protocol,
  streamEventSchema,
} from "@kenfutwork/shared";
import { HumanMessage } from "@langchain/core/messages";
import type { ModelSelection } from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import { effectiveNativeMessages } from "../../agent/native-context-history.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  CATALOG_COMPACT_MODEL,
  catalogCompactionModelFixture,
  catalogModelText,
  catalogUserText,
} from "./compaction-catalog-metadata.fixture.js";
import {
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
  snapshot,
  task,
} from "./guide-state-test.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";

// 场景数据与显式用户配置，不定义生产默认、阈值或区间护栏。
const PRE_COMPACT_TURNS = 4;
const TOTAL_TURNS = 5;
const FALLBACK_KEEP_TARGET = 3;
const KNOWN_KEEP_TARGET = 2;

async function configureManualRetention(fixture: Fixture) {
  const before = await fixture.client.request("/api/instance/settings");
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  instanceSettingsResponseSchema.parse(before.body);
  const changed = await fixture.client.request(
    "/api/instance/settings",
    {
      compactFallbackKeepMessages: FALLBACK_KEEP_TARGET,
      compactKeepMessages: KNOWN_KEEP_TARGET,
      autoCompactEnabled: false,
    },
    "PATCH",
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  const reread = await fixture.client.request("/api/instance/settings");
  expect(reread.status, JSON.stringify(reread.body)).toBe(200);
  for (const response of [changed, reread])
    expect(
      instanceSettingsResponseSchema.parse(response.body).settings,
    ).toMatchObject({
      compactFallbackKeepMessages: FALLBACK_KEEP_TARGET,
      compactKeepMessages: KNOWN_KEEP_TARGET,
      autoCompactEnabled: false,
    });
}

async function readScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function sendRound(
  fixture: Fixture,
  host: Host,
  original: Original,
  selection: ModelSelection,
  round: number,
) {
  const commandId = randomUUID();
  const sent = await host.command(
    "sendText",
    {
      text: catalogUserText(round),
      modelSelection: selection,
      mode: "build",
      planEnabled: false,
    },
    commandId,
  );
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  const runId = await finishRound(host, commandId, round);
  await assertOwnedRun(fixture, host, original, runId, commandId, selection);
  return { commandId, runId };
}

async function compactPublicly(
  fixture: Fixture,
  host: Host,
  original: Original,
  selection: ModelSelection,
  model: Model,
) {
  const commandId = randomUUID();
  const sent = await host.command("compact", {}, commandId);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  return vi.waitFor(
    async () => {
      const current = await task(fixture, host);
      assertTaskUnchanged(current, original, fixture, null);
      const input = current.state.inputs?.find(
        (entry) => entry.intent.sourceCommandId === commandId,
      );
      if (!input) throw new Error("原V4 compact没有持久维护输入。");
      expect(input).toMatchObject({
        status: "settled",
        scopeGeneration: Number(original.scope_generation),
        branchGeneration: Number(original.branch_generation),
        intent: {
          kind: "compact",
          text: "",
          clientId: host.clientId,
          sourceCommandId: commandId,
          modelSelection: selection,
          mode: "build",
          planEnabled: false,
        },
        modelInvocation: {
          providerId: selection.providerId,
          modelId: selection.modelId,
        },
      });
      const value = await snapshot(host);
      expect(value.control).toMatchObject({
        phase: "completedSuccess",
        canStop: false,
        activeWorks: [],
      });
      expect(value.pendingInteractions).toEqual([]);
      expect(value.queue.items).toEqual([]);
      expect(value.config.modelSelection).toEqual(selection);
      expect(
        value.rows.window.filter((row) => row.kind === "timelineMarker"),
      ).toEqual([
        expect.objectContaining({
          entityId: `compact:${input.runId}`,
          marker: { type: "compact", origin: "manual", status: "success" },
        }),
      ]);
      expect(model.requests.map((request) => request.kind)).toEqual([
        ...Array.from({ length: PRE_COMPACT_TURNS }, () => "normal"),
        "summary",
      ]);
      return { commandId, runId: input.runId, input: structuredClone(input) };
    },
    { timeout: TEST_SYNC_TIMEOUT_MS },
  );
}

function assertSdkSummary(model: Model) {
  const summaries = model.requests.filter(
    (request) => request.kind === "summary",
  );
  expect(summaries).toHaveLength(1);
  const summary = summaries[0];
  if (!summary) throw new Error("原SDK没有发出真实摘要HTTP请求。");
  expect(summary.body.model).toBe(CATALOG_COMPACT_MODEL);
  expect(summary.endpoint).toBe("");
  expect(summary.body.messages).toHaveLength(1);
  expect(summary.body.tools ?? []).toEqual([]);
  expect(catalogModelText(summary.body.messages[0]?.content)).toContain(
    catalogUserText(1),
  );
  expect(model.errors).toEqual([]);
  return summary;
}

async function assertMaintenanceNative(
  fixture: Fixture,
  host: Host,
  original: Original,
  compact: Awaited<ReturnType<typeof compactPublicly>>,
  summaryReply: string,
) {
  const pre = await readNativeBoundaryState(
    fixture,
    host,
    compact.runId,
    "pre",
  );
  const post = await vi.waitFor(
    () => readNativeBoundaryState(fixture, host, compact.runId, "post"),
    { timeout: TEST_SYNC_TIMEOUT_MS },
  );
  for (const entry of [pre, post])
    expect(entry.boundary).toMatchObject({
      instanceId: fixture.actor.instanceId,
      projectId: host.projectId,
      taskId: host.sessionId,
      runId: compact.runId,
      scopeGeneration: Number(original.scope_generation),
      branchGeneration: Number(original.branch_generation),
      operation: { kind: "compact" },
      inputOrigin: "controlOperation",
      inputMessageId: null,
      inputIdentity: {
        clientId: host.clientId,
        sourceCommandId: compact.commandId,
      },
      context: { status: "captured" },
    });
  expect(post.boundary.context).not.toEqual(pre.boundary.context);
  if (!Array.isArray(pre.state.messages) || !Array.isArray(post.state.messages))
    throw new Error("维护Run的原native pre/post缺少消息。");
  const before = effectiveNativeMessages(pre.state.messages, pre.state);
  const after = effectiveNativeMessages(post.state.messages, post.state);
  expect(after.length).toBeLessThan(before.length);
  const summaries = after
    .filter(HumanMessage.isInstance)
    .filter(
      (message) => message.additional_kwargs.lc_source === "summarization",
    );
  expect(summaries).toHaveLength(1);
  expect(catalogModelText(summaries[0]?.content)).toContain(summaryReply);
  const immutablePre = await readNativeBoundaryState(
    fixture,
    host,
    compact.runId,
    "pre",
  );
  expect(immutablePre.state.messages).toEqual(pre.state.messages);
  return post.boundary.context;
}

async function assertManualJournal(
  fixture: Fixture,
  host: Host,
  runId: string,
) {
  const compacted = await readCatalogCompactedEvents(fixture, host);
  expect(compacted).toEqual([
    expect.objectContaining({
      runId,
      origin: "manual",
      keepMessages: FALLBACK_KEEP_TARGET,
    }),
  ]);
  expect(compacted[0]).not.toHaveProperty("triggerSource");
  expect(compacted[0]).not.toHaveProperty("triggerTokens");
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ payload: unknown }>(
      `select payload from public.code_ui_events where instance_id=:instance and root_session_id=$1
       and payload->>'runId'=$2 and payload->>'type' in ('run.compacted','run.completed') order by seq`,
      [host.sessionId, runId],
    );
  expect(rows.map((row) => streamEventSchema.parse(row.payload))).toMatchObject(
    [
      {
        type: "run.compacted",
        runId,
        origin: "manual",
        keepMessages: FALLBACK_KEEP_TARGET,
      },
      {
        type: "run.completed",
        runId,
        operationResult: { kind: "compact", status: "applied" },
      },
    ],
  );
  return compacted;
}

async function prepareMaintenance(fixture: Fixture, host: Host, model: Model) {
  const selection = await declareAndQualify(host, {
    contextWindow: null,
    maxOutputTokens: null,
    expectedAutoCompactEnabled: false,
  });
  const original = await task(fixture, host);
  const scope = await readScope(host);
  await assertCatalogNoCanvas(fixture, host, original);
  const commandIds: string[] = [];
  const runIds: string[] = [];
  for (let round = 1; round <= PRE_COMPACT_TURNS; round++) {
    const completed = await sendRound(
      fixture,
      host,
      original,
      selection,
      round,
    );
    commandIds.push(completed.commandId);
    runIds.push(completed.runId);
  }
  expect(model.requests.map((request) => request.round)).toEqual([1, 2, 3, 4]);
  expect(model.requests.every((request) => request.kind === "normal")).toBe(
    true,
  );
  expect(await readCatalogCompactedEvents(fixture, host)).toEqual([]);
  expect(
    (await snapshot(host)).rows.window.filter(
      (row) => row.kind === "timelineMarker",
    ),
  ).toEqual([]);
  expect(await readScope(host)).toEqual(scope);
  const compact = await compactPublicly(
    fixture,
    host,
    original,
    selection,
    model,
  );
  expect(runIds).not.toContain(compact.runId);
  const summary = assertSdkSummary(model);
  const postContext = await assertMaintenanceNative(
    fixture,
    host,
    original,
    compact,
    summary.reply,
  );
  const journal = await assertManualJournal(fixture, host, compact.runId);
  await assertFullHistory(fixture, host, compact.runId, commandIds, "", [
    compact.commandId,
  ]);
  expect(await readScope(host)).toEqual(scope);
  return {
    selection,
    original,
    scope,
    commandIds,
    runIds,
    compact,
    summary,
    postContext,
    journal,
  };
}

type Prepared = Awaited<ReturnType<typeof prepareMaintenance>>;

async function assertCompactDuplicate(
  fixture: Fixture,
  host: Host,
  model: Model,
  prepared: Prepared,
) {
  const { original, scope, compact, journal, postContext } = prepared;
  const repeated = await host.command("compact", {}, compact.commandId);
  expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(repeated.body.result).status).toBe(
    "duplicate",
  );
  const replayed = await task(fixture, host);
  assertTaskUnchanged(replayed, original, fixture, null);
  expect(
    replayed.state.inputs?.find(
      (entry) => entry.intent.sourceCommandId === compact.commandId,
    ),
  ).toEqual(compact.input);
  expect(await readScope(host)).toEqual(scope);
  expect(await readCatalogCompactedEvents(fixture, host)).toEqual(journal);
  const duplicatePost = await readNativeBoundaryState(
    fixture,
    host,
    compact.runId,
    "post",
  );
  expect(duplicatePost.boundary.context).toEqual(postContext);
  expect(model.requests).toHaveLength(PRE_COMPACT_TURNS + 1);
}

async function continueFifthRound(
  fixture: Fixture,
  host: Host,
  model: Model,
  prepared: Prepared,
) {
  const { selection, original, commandIds, runIds, compact, summary, scope } =
    prepared;
  const fifth = await sendRound(
    fixture,
    host,
    original,
    selection,
    TOTAL_TURNS,
  );
  commandIds.push(fifth.commandId);
  expect(commandIds).toHaveLength(TOTAL_TURNS);
  runIds.push(fifth.runId);
  expect(new Set([...runIds, compact.runId]).size).toBe(commandIds.length + 1);
  const next = model.requests.at(-1);
  if (next?.kind !== "normal")
    throw new Error("维护后没有第五轮实际普通请求。");
  expect(next.round).toBe(TOTAL_TURNS);
  const history = next.body.messages
    .map((message) => catalogModelText(message.content))
    .join("\n");
  expect(history).toContain(summary.reply);
  expect(history).not.toContain("CATALOG_COMPACT_USER_1_381dfc02");
  expect(history).toContain(catalogUserText(TOTAL_TURNS));
  expect(
    model.requests
      .filter((request) => request.kind === "normal")
      .map((request) => request.round),
  ).toEqual([1, 2, 3, 4, 5]);
  expect(
    model.requests.filter((request) => request.kind === "summary"),
  ).toHaveLength(1);
  expect(model.errors).toEqual([]);
  await assertManualJournal(fixture, host, compact.runId);
  await assertFullHistory(fixture, host, fifth.runId, commandIds, "", [
    compact.commandId,
  ]);
  expect(await readScope(host)).toEqual(scope);
  await vi.waitFor(
    () => expect(model.requests.every((request) => request.closed)).toBe(true),
    { timeout: TEST_SYNC_TIMEOUT_MS },
  );
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "未知窗口保留目标与原V4手动压缩 integration",
  () => {
    it(
      "关闭自动摘要后四轮无压缩，原compact采用fallback keep3且第五轮消费摘要并保留全历史，重放不重复",
      async () => {
        const model = await catalogCompactionModelFixture({
          turns: TOTAL_TURNS,
        });
        let fixture: Fixture | undefined;
        let host: Host | undefined;
        try {
          fixture = await createCodeUiHttpFixture();
          await configureManualRetention(fixture);
          host = await createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          const prepared = await prepareMaintenance(fixture, host, model);
          await assertCompactDuplicate(fixture, host, model, prepared);
          await continueFifthRound(fixture, host, model, prepared);
        } finally {
          await disposeCatalogFixture(model, host, fixture);
        }
      },
      TEST_CASE_TIMEOUT_MS,
    );
  },
);
