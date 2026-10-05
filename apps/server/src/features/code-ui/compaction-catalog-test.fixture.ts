import {
  AGENT_GOVERNANCE_DEFAULTS,
  instanceSettingsResponseSchema,
  modelListResponseSchema,
  providerInstanceListResponseSchema,
  streamEventSchema,
} from "@kenfutwork/shared";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  completeNewModelSelection,
  type ModelSelection,
  type ModelSelectionView,
} from "@zcode/provider";
import { modelSelectionSchema } from "@zcode/shared";
import { expect, vi } from "vitest";
import { effectiveNativeMessages } from "../../agent/native-context-history.js";
import type { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  CATALOG_COMPACT_EXPECTED_TRIGGER,
  CATALOG_COMPACT_MAX_OUTPUT,
  CATALOG_COMPACT_MODEL,
  CATALOG_COMPACT_WINDOW,
  type catalogCompactionModelFixture,
  catalogModelText,
  catalogReplyText,
  catalogUserText,
} from "./compaction-catalog-metadata.fixture.js";
import {
  assertTaskUnchanged,
  readNativeBoundaryState,
  snapshot,
  task,
} from "./guide-state-test.fixture.js";
import type { createCodeSessionFixture } from "./host-session.fixture.js";

export type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
export type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
export type Model = Awaited<ReturnType<typeof catalogCompactionModelFixture>>;
export type Original = Awaited<ReturnType<typeof task>>;
// 独占HTTP/PG/native同步期限与固定历史规模，只是测试预算，不进入Agent运行时治理。
export const TEST_SYNC_TIMEOUT_MS = 30_000;
export const TEST_CASE_TIMEOUT_MS = 180_000;

export async function declareAndQualify(
  host: Host,
  declarations: {
    providerId?: string;
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
    expectedAutoCompactEnabled?: boolean;
  } = {},
) {
  const initial = await snapshot(host);
  const providerId =
    declarations.providerId ??
    modelSelectionSchema.parse(initial.config.modelSelection).providerId;
  const contextWindow =
    declarations.contextWindow === null
      ? undefined
      : (declarations.contextWindow ?? CATALOG_COMPACT_WINDOW);
  const maxOutputTokens =
    declarations.maxOutputTokens === null
      ? undefined
      : (declarations.maxOutputTokens ?? CATALOG_COMPACT_MAX_OUTPUT);
  await declareCatalogModel(host, providerId, contextWindow, maxOutputTokens);
  return qualifyCatalogModel(
    host,
    providerId,
    declarations.expectedAutoCompactEnabled ?? true,
  );
}

async function declareCatalogModel(
  host: Host,
  providerId: string,
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
) {
  // 原Provider RPC是唯一声明写入口；不PATCH defaultModel，不用内核fake catalog。
  const added = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method: "addPersonalModel",
    args: [
      providerId,
      CATALOG_COMPACT_MODEL,
      {
        ...(contextWindow !== undefined
          ? { properties: { contextWindow } }
          : {}),
        ...(maxOutputTokens !== undefined
          ? { optionSpecs: { maxOutputTokens: { max: maxOutputTokens } } }
          : {}),
      },
    ],
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const instancesResponse = await host.client.request(
    "/api/provider-instances",
  );
  expect(instancesResponse.status).toBe(200);
  const instance = providerInstanceListResponseSchema
    .parse(instancesResponse.body)
    .instances.find((entry) => entry.id === providerId);
  const declared = instance?.models.find(
    (entry) => entry.id === CATALOG_COMPACT_MODEL,
  );
  expect(declared).toMatchObject({ id: CATALOG_COMPACT_MODEL });
  expect(declared?.contextWindow).toBe(contextWindow);
  expect(declared?.maxOutputTokens).toBe(maxOutputTokens);
  const catalogResponse = await host.client.request("/api/models");
  expect(catalogResponse.status).toBe(200);
  const listed = modelListResponseSchema
    .parse(catalogResponse.body)
    .models.find(
      (entry) => entry.id === `${providerId}:${CATALOG_COMPACT_MODEL}`,
    );
  expect(listed).toMatchObject({
    id: `${providerId}:${CATALOG_COMPACT_MODEL}`,
    provider: providerId,
  });
  expect(listed?.contextWindow).toBe(contextWindow);
  expect(listed?.maxOutputTokens).toBe(maxOutputTokens);
}

async function qualifyCatalogModel(
  host: Host,
  providerId: string,
  expectedAutoCompactEnabled: boolean,
) {
  const result = await host.client.request("/api/code-ui/rpc", {
    service: "modelSelectionService",
    method: "getView",
    args: [],
  });
  expect(result.status).toBe(200);
  const view: ModelSelectionView = result.body.result;
  const candidate = completeNewModelSelection(view, {
    providerId,
    modelId: CATALOG_COMPACT_MODEL,
  });
  if (!candidate)
    throw new Error("公开选择器无法完成已声明自定义模型的合法Selection。");
  const selection = modelSelectionSchema.parse(candidate);
  const qualified = await host.client.request("/api/code-ui/rpc", {
    service: "modelSelectionService",
    method: "getView",
    args: [{ selection }],
  });
  expect(qualified.status).toBe(200);
  expect(qualified.body.result.selectionIssue).toBeUndefined();
  expect(
    modelSelectionSchema.parse(qualified.body.result.effectiveSelection),
  ).toEqual(selection);
  const settingsResponse = await host.client.request("/api/instance/settings");
  expect(settingsResponse.status).toBe(200);
  expect(
    instanceSettingsResponseSchema.parse(settingsResponse.body).settings
      .autoCompactEnabled,
  ).toBe(expectedAutoCompactEnabled);
  return selection;
}

export async function finishRound(
  host: Host,
  commandId: string,
  round: number,
  endpoint = "",
) {
  return vi.waitFor(
    async () => {
      const value = await snapshot(host);
      const header = value.rows.window.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === commandId,
      );
      if (header?.kind !== "turnHeader")
        throw new Error("本次原sendText轮次尚未出现在权威转录。");
      expect(header.state, JSON.stringify(value.control.lastError)).toBe(
        "completedSuccess",
      );
      expect(value.control).toMatchObject({
        phase: "completedSuccess",
        canStop: false,
        activeWorks: [],
      });
      expect(value.pendingInteractions).toEqual([]);
      expect(value.queue.items).toEqual([]);
      expect(value.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          turnId: header.turnId,
          text: catalogReplyText(round, endpoint),
          state: "complete",
        }),
      );
      return header.turnId;
    },
    { timeout: TEST_SYNC_TIMEOUT_MS },
  );
}

export async function assertOwnedRun(
  fixture: Fixture,
  host: Host,
  original: Original,
  runId: string,
  commandId: string,
  selection?: ModelSelection,
) {
  const current = await task(fixture, host);
  assertTaskUnchanged(current, original, fixture, null);
  const input = current.state.inputs?.find(
    (entry) => entry.intent.sourceCommandId === commandId,
  );
  if (!input) throw new Error("自然完成的canonical用户输入缺失。");
  expect(input).toMatchObject({
    runId,
    scopeGeneration: Number(original.scope_generation),
    branchGeneration: Number(original.branch_generation),
    status: "settled",
    intent: {
      clientId: host.clientId,
      kind: "sendText",
      modelSelection: { modelId: CATALOG_COMPACT_MODEL },
    },
  });
  if (selection) {
    expect(input.intent.modelSelection).toEqual(selection);
    expect(input.modelInvocation).toMatchObject({
      providerId: selection.providerId,
      modelId: selection.modelId,
    });
  }
  const { boundary } = await vi.waitFor(
    () => readNativeBoundaryState(fixture, host, runId, "post"),
    { timeout: TEST_SYNC_TIMEOUT_MS },
  );
  expect(boundary).toMatchObject({
    instanceId: fixture.actor.instanceId,
    projectId: host.projectId,
    taskId: host.sessionId,
    runId,
    phase: "post",
    scopeGeneration: Number(original.scope_generation),
    branchGeneration: Number(original.branch_generation),
    inputOrigin: "userInput",
    inputIdentity: { clientId: host.clientId, sourceCommandId: commandId },
    context: { status: "captured" },
  });
  expect(boundary.operation).toBeUndefined();
  return boundary;
}

export async function assertAutoEvidence(
  fixture: Fixture,
  host: Host,
  model: Model,
  runIds: string[],
  options: {
    triggerTokens?: number;
    endpoint?: string;
    keepMessages?: number;
  } = {},
) {
  const compacted = await readCatalogCompactedEvents(fixture, host);
  // 要求真实自动压缩事实；错误specifier匹配导致的fallback170k无法由有限历史掩盖。
  expect(
    compacted.length,
    "已声明自定义窗口/输出必须触发真实自动压缩，不能仍落fallback170000。",
  ).toBeGreaterThan(0);
  for (const event of compacted) {
    expect(runIds).toContain(event.runId);
    expect(event.origin).not.toBe("manual");
    expect(event).toMatchObject({
      triggerTokens: options.triggerTokens ?? CATALOG_COMPACT_EXPECTED_TRIGGER,
      triggerSource: "reserved-output",
      keepMessages:
        options.keepMessages ?? AGENT_GOVERNANCE_DEFAULTS.compactKeepMessages,
    });
  }
  expect(model.errors).toEqual([]);
  const summaryIndex = model.requests.findIndex(
    (request) => request.kind === "summary",
  );
  const summary = model.requests[summaryIndex];
  if (summary?.kind !== "summary")
    throw new Error("真实SDK没有发出native摘要模型请求。");
  expect(summary.endpoint).toBe(options.endpoint ?? "");
  expect(summary.body.model).toBe(CATALOG_COMPACT_MODEL);
  expect(summary.body.messages).toHaveLength(1);
  expect(summary.body.tools ?? []).toEqual([]);
  expect(catalogModelText(summary.body.messages[0]?.content)).toContain(
    catalogUserText(1),
  );
  const next = model.requests
    .slice(summaryIndex + 1)
    .find((request) => request.kind === "normal");
  if (!next) throw new Error("自动摘要之后没有实际普通模型请求。");
  const history = next.body.messages
    .map((message) => catalogModelText(message.content))
    .join("\n");
  expect(history).toContain(summary.reply);
  expect(history).not.toContain("CATALOG_COMPACT_USER_1_381dfc02");
  expect(next.body.model).toBe(CATALOG_COMPACT_MODEL);
  expect(next.endpoint).toBe(options.endpoint ?? "");
  const completed = await snapshot(host);
  expect(completed.rows.window).toContainEqual(
    expect.objectContaining({
      kind: "timelineMarker",
      marker: { type: "compact", origin: "auto", status: "success" },
    }),
  );
}

export async function assertFullHistory(
  fixture: Fixture,
  host: Host,
  finalRunId: string,
  commandIds: string[],
  endpoint = "",
  maintenanceCommandIds: readonly string[] = [],
) {
  const post = await readNativeBoundaryState(fixture, host, finalRunId, "post");
  const messages = post.state.messages;
  if (!Array.isArray(messages))
    throw new Error("自然完成post缺少真实native messages。");
  const userTexts = commandIds.map((_, index) => catalogUserText(index + 1));
  for (const text of userTexts)
    expect(
      messages
        .filter(HumanMessage.isInstance)
        .filter((message) => message.content === text),
    ).toHaveLength(1);
  for (let round = 1; round <= commandIds.length; round++)
    expect(
      messages
        .filter(AIMessage.isInstance)
        .some(
          (message) => message.content === catalogReplyText(round, endpoint),
        ),
    ).toBe(true);
  const effective = effectiveNativeMessages(messages, post.state);
  expect(effective.length).toBeLessThan(messages.length);
  const summaries = effective
    .filter(HumanMessage.isInstance)
    .filter(
      (message) => message.additional_kwargs.lc_source === "summarization",
    );
  expect(summaries).toHaveLength(1);
  expect(JSON.stringify(summaries[0]?.content)).toContain(
    "NATIVE_CATALOG_SUMMARY_",
  );
  const current = await task(fixture, host);
  expect(current.state.inputs).toHaveLength(
    commandIds.length + maintenanceCommandIds.length,
  );
  const transcript = (await snapshot(host)).rows.window
    .filter((row) => row.kind === "userInput")
    .filter((row) => row.origin === "realUser");
  expect(transcript).toHaveLength(commandIds.length);
  for (const [index, commandId] of commandIds.entries()) {
    expect(transcript).toContainEqual(
      expect.objectContaining({
        sourceCommandId: commandId,
        text: userTexts[index],
      }),
    );
    expect(
      current.state.inputs?.filter(
        (input) => input.intent.sourceCommandId === commandId,
      ),
    ).toHaveLength(1);
  }
  for (const commandId of maintenanceCommandIds) {
    const inputs = current.state.inputs?.filter(
      (input) => input.intent.sourceCommandId === commandId,
    );
    expect(inputs).toEqual([
      expect.objectContaining({
        status: "settled",
        intent: expect.objectContaining({
          kind: "compact",
          text: "",
          clientId: host.clientId,
          sourceCommandId: commandId,
        }),
      }),
    ]);
    expect(
      transcript.filter((row) => row.sourceCommandId === commandId),
    ).toEqual([]);
  }
}

export async function readCatalogCompactedEvents(fixture: Fixture, host: Host) {
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ payload: unknown }>(
      `select payload from public.code_ui_events where instance_id=:instance and root_session_id=$1
       and payload->>'type'='run.compacted' order by seq`,
      [host.sessionId],
    );
  return rows
    .map((row) => streamEventSchema.parse(row.payload))
    .filter((event) => event.type === "run.compacted");
}

export async function assertCatalogNoCanvas(
  fixture: Fixture,
  host: Host,
  original: Original,
) {
  expect(original).toMatchObject({
    instance_id: fixture.actor.instanceId,
    project_id: host.projectId,
    parent_session_id: null,
  });
  const project = await host.client.request(`/api/projects/${host.projectId}`);
  expect(project.status).toBe(200);
  expect(project.body.project.kind).toBe("code");
  const ownership = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .queryOne<{
      mode: string;
      created_by_client_id: string;
      canvases: string;
    }>(
      `select s.mode, s.created_by_client_id,
       (select count(*)::text from public.canvases c join public.projects p on p.id=c.project_id
        where p.instance_id=:instance and c.project_id=s.project_id) as canvases
       from public.chat_sessions s where s.instance_id=:instance and s.id=$1`,
      [original.chat_session_id],
    );
  expect(ownership).toMatchObject({
    mode: "code",
    created_by_client_id: fixture.actor.accessClientId,
    canvases: "0",
  });
}

/** 原fixture的串行teardown全部尝试；额外实例也经原RPC释放。 */
export async function disposeCatalogFixture(
  model: Model,
  host: Host | undefined,
  fixture: Fixture | undefined,
  extraProviderId?: string,
) {
  let failure: unknown;
  const cleanups = [
    async () => {
      if (host && (await snapshot(host)).control.activeWorks.length)
        await host.command("stop", {});
    },
    () => model.close(),
    async () => {
      if (host && extraProviderId)
        await host.client.request("/api/code-ui/rpc", {
          service: "providerSettingsService",
          method: "deletePersonalProvider",
          args: [extraProviderId],
        });
    },
    () => host?.dispose(),
    () => fixture?.close(),
  ];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}
