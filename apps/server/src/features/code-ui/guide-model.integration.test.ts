import { randomUUID } from "node:crypto";
import {
  zcodeUiProtocol as protocol,
  usageSummaryResponseSchema,
} from "@kenfutwork/shared";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  completeNewModelSelection,
  type ModelSelectionView,
  type ProviderSettingsView,
} from "@zcode/provider";
import { modelSelectionSchema } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { decodeNativeContextReference } from "../../agent/native-context-reference.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  GUIDE_MODEL_A,
  GUIDE_MODEL_B,
  guideModelFixture,
  guideModelText,
} from "./guide-model.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { createCodeUiRepository } from "./repository.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof guideModelFixture>>;
const INITIAL_TEXT = "GUIDE_MODEL_A_INITIAL_1f074c9e：保持正文流等待指导。";
const GUIDE_TEXT =
  "GUIDE_MODEL_B_SAME_RUN_746e510c：沿当前轮改用所选B模型继续。";

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

async function summary(host: Host) {
  const response = await host.client.request("/api/usage/summary");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return usageSummaryResponseSchema.parse(response.body);
}

async function qualifyModelB(host: Host) {
  const initial = await snapshot(host);
  const selectionA = modelSelectionSchema.parse(initial.config.modelSelection);
  expect(selectionA.modelId, "前置：宿主默认模型必须是实际A。").toBe(
    GUIDE_MODEL_A,
  );
  const added = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method: "addPersonalModel",
    args: [selectionA.providerId, GUIDE_MODEL_B, {}],
  });
  expect(
    added.status,
    `前置：B模型添加失败 ${JSON.stringify(added.body)}`,
  ).toBe(200);
  const registry = await host.client.request("/api/code-ui/rpc", {
    service: "modelSelectionService",
    method: "getView",
    args: [],
  });
  expect(
    registry.status,
    `前置：真实registry view不可读 ${JSON.stringify(registry.body)}`,
  ).toBe(200);
  const view: ModelSelectionView = registry.body.result;
  const candidate = completeNewModelSelection(view, {
    providerId: selectionA.providerId,
    modelId: GUIDE_MODEL_B,
  });
  if (!candidate)
    throw new Error(
      "前置资格失败：B不在真实view可选项或没有合法reasoning档位。",
    );
  const selectionB = modelSelectionSchema.parse(candidate);
  const qualified = await host.client.request("/api/code-ui/rpc", {
    service: "modelSelectionService",
    method: "getView",
    args: [{ selection: selectionB }],
  });
  expect(
    qualified.status,
    `前置：B资格view失败 ${JSON.stringify(qualified.body)}`,
  ).toBe(200);
  expect(
    qualified.body.result.selectionIssue,
    "前置：B仍有模型资格问题。",
  ).toBeUndefined();
  expect(
    modelSelectionSchema.parse(qualified.body.result.effectiveSelection),
  ).toEqual(selectionB);
  const aQualified = await host.client.request("/api/code-ui/rpc", {
    service: "modelSelectionService",
    method: "getView",
    args: [{ selection: selectionA }],
  });
  expect(aQualified.status, "前置：添加B后A资格必须仍有效。").toBe(200);
  expect(
    modelSelectionSchema.parse(aQualified.body.result.effectiveSelection),
  ).toEqual(selectionA);
  return {
    selectionA,
    selectionB,
    submission: {
      mode: initial.config.mode,
      planEnabled: initial.config.planEnabled,
    },
  };
}

async function waitForPartial(host: Host, model: Model, index: number) {
  // 测试独占HTTP/PG/SSE同步期限，非Agent运行时治理值。
  return vi.waitFor(
    async () => {
      expect(model.requests).toHaveLength(index + 1);
      const request = model.requests[index];
      if (!request) throw new Error("真实模型HTTP请求尚未出现。");
      const active = await snapshot(host);
      expect(active.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          text: guideModelText(request.body.model),
          state: "streaming",
        }),
      );
      const primary = active.control.activeWorks.filter(
        (work) => work.kind === "primaryTurn",
      );
      expect(primary).toHaveLength(1);
      const runId = primary[0]?.foregroundExecutionId;
      if (!runId) throw new Error("实际模型正文流缺少活动Run身份。");
      expect(active.pendingInteractions).toEqual([]);
      return { active, runId };
    },
    { timeout: 30_000 },
  );
}

function assertTaskIdentity(
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

function assertCanonicalSelections(
  current: Awaited<ReturnType<typeof task>>,
  commands: { initial: string; guide: string },
  selections: Awaited<ReturnType<typeof qualifyModelB>>,
  host: Host,
) {
  const inputs = current.state.inputs ?? [];
  const a = inputs.find(
    (input) => input.intent.sourceCommandId === commands.initial,
  );
  const b = inputs.find(
    (input) => input.intent.sourceCommandId === commands.guide,
  );
  if (!a || !b)
    throw new Error(
      "前置prepareInputModel失败：A/B canonical输入或冻结执行快照缺失。",
    );
  for (const [input, selection] of [
    [a, selections.selectionA],
    [b, selections.selectionB],
  ] as const) {
    expect(
      input.intent.modelSelection,
      "前置：sendText必须保存完整qualified选择。",
    ).toEqual(selection);
    expect(
      input.modelInvocation,
      "前置：实际prepareInputModel必须成功编译冻结选择。",
    ).toMatchObject({
      providerId: selection.providerId,
      modelId: selection.modelId,
    });
    expect(input.modelInvocation.configRevision).toEqual(expect.any(Number));
    expect(input.intent).toMatchObject({
      clientId: host.clientId,
      mode: selections.submission.mode,
      planEnabled: selections.submission.planEnabled,
    });
  }
  expect(
    inputs.filter((input) => input.intent.sourceCommandId === commands.guide),
  ).toHaveLength(1);
  return { a, b };
}

async function assertNativeUsage(
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
    throw new Error("同Run自然完成未产生真实native post。");
  const native = decodeNativeContextReference(reference.reference);
  const persistence = await fixture.app.kernel
    .get("agentPersistence")
    .getPersistence();
  if (!persistence) throw new Error("真实native上下文消费者缺失。");
  const checkpoint = await persistence.checkpointer.get({
    configurable: {
      thread_id: native.threadId,
      checkpoint_ns: native.namespace,
      checkpoint_id: native.checkpointId,
    },
  });
  const messages = checkpoint?.channel_values.messages;
  if (!Array.isArray(messages)) throw new Error("native消息未持久化。");
  const ai = messages.filter(AIMessage.isInstance);
  for (const [modelId, input, output] of [
    [GUIDE_MODEL_A, 10, 3],
    [GUIDE_MODEL_B, 20, 7],
  ] as const) {
    const matched = ai.filter(
      (message) => message.content === guideModelText(modelId),
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]?.usage_metadata).toMatchObject({
      input_tokens: input,
      output_tokens: output,
    });
  }
  expect(messages).toContainEqual(
    expect.objectContaining({ id: guideEntityId, content: GUIDE_TEXT }),
  );
  expect(
    messages.filter((message) => message?.id === guideEntityId),
  ).toHaveLength(1);
}

async function assertUsageOwnership(
  fixture: Fixture,
  host: Host,
  runId: string,
  providerId: string,
) {
  await vi.waitFor(
    async () => {
      const usage = await summary(host);
      expect(usage.totals).toMatchObject({ inputTokens: 30, outputTokens: 10 });
      expect(usage.byModel).toHaveLength(2);
      expect(usage.byModel).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "instance",
            model: GUIDE_MODEL_A,
            capability: "chat",
            inputTokens: 10,
            outputTokens: 3,
          }),
          expect.objectContaining({
            provider: "instance",
            model: GUIDE_MODEL_B,
            capability: "chat",
            inputTokens: 20,
            outputTokens: 7,
          }),
        ]),
      );
    },
    { timeout: 30_000 },
  );
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{
      provider: string;
      model: string;
      provider_instance_id: string;
      instance_id: string;
      access_client_id: string | null;
      input_tokens: string;
      output_tokens: string;
      total_tokens: string;
    }>(
      `select provider,model,provider_instance_id,instance_id,access_client_id,
              sum(input_tokens)::text as input_tokens,
              sum(output_tokens)::text as output_tokens,
              sum(total_tokens)::text as total_tokens
       from public.usage_records where instance_id=:instance and run_id=$1
       group by provider,model,provider_instance_id,instance_id,access_client_id`,
      [runId],
    );
  expect(rows).toHaveLength(2);
  for (const [modelId, input, output] of [
    [GUIDE_MODEL_A, 10, 3],
    [GUIDE_MODEL_B, 20, 7],
  ] as const) {
    const row = rows.find((record) => record.model === modelId);
    expect(row).toMatchObject({
      provider: "instance",
      model: modelId,
      provider_instance_id: providerId,
      instance_id: fixture.actor.instanceId,
      access_client_id: fixture.actor.accessClientId,
      input_tokens: String(input),
      output_tokens: String(output),
      total_tokens: String(input + output),
    });
  }
  expect((await snapshot(host)).usage.cumulative).toMatchObject({
    inputTokens: 30,
    outputTokens: 10,
  });
}

async function prepareModelGuide(
  fixture: Fixture,
  host: Host,
  model: Model,
  choices: Awaited<ReturnType<typeof qualifyModelB>>,
) {
  const commands = { initial: randomUUID(), guide: randomUUID() };
  const initial = await host.command(
    "sendText",
    {
      text: INITIAL_TEXT,
      modelSelection: choices.selectionA,
      ...choices.submission,
    },
    commands.initial,
  );
  expect(
    initial.status,
    `前置：A请求接收失败 ${JSON.stringify(initial.body)}`,
  ).toBe(200);
  expect(protocol.commandAckSchema.parse(initial.body.result).status).toBe(
    "accepted",
  );
  const first = await waitForPartial(host, model, 0);
  const original = await task(fixture, host);
  expect(original.root_directory).toBe(host.workspacePath);
  expect(await runIds(fixture, host)).toEqual([first.runId]);
  const originalInput = original.state.inputs?.find(
    (input) => input.intent.sourceCommandId === commands.initial,
  );
  if (!originalInput) throw new Error("前置：真实A请求缺少canonical执行快照。");
  const frozenA = structuredClone(originalInput.modelInvocation);
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
  const payload = {
    text: GUIDE_TEXT,
    modelSelection: choices.selectionB,
    ...choices.submission,
  };
  const accepted = await host.command("sendText", payload, commands.guide);
  expect(
    accepted.status,
    `前置prepareInputModel：B资格或编译失败 ${JSON.stringify(accepted.body)}`,
  ).toBe(200);
  const ack = protocol.commandAckSchema.parse(accepted.body.result);
  expect(ack).toMatchObject({
    status: "accepted",
    result: {
      type: "inputAccepted",
      delivery: "queue",
      inputId: commands.guide,
    },
  });
  const admitted = await task(fixture, host);
  assertTaskIdentity(admitted, original, fixture, first.runId);
  const frozen = assertCanonicalSelections(admitted, commands, choices, host);
  expect(frozen.a.modelInvocation).toEqual(frozenA);
  const frozenB = structuredClone(frozen.b.modelInvocation);
  const repeated = await host.command("sendText", payload, commands.guide);
  expect(protocol.commandAckSchema.parse(repeated.body.result)).toEqual({
    ...ack,
    status: "duplicate",
  });
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]?.closed).toBe(false);
  return { first, original, commands, payload, ack, frozenA, frozenB };
}

async function assertModelBoundaryB(
  fixture: Fixture,
  host: Host,
  model: Model,
  choices: Awaited<ReturnType<typeof qualifyModelB>>,
  prepared: Awaited<ReturnType<typeof prepareModelGuide>>,
) {
  const { first, original, commands, frozenA, frozenB, payload, ack } =
    prepared;
  const second = await waitForPartial(host, model, 1);
  // 资格和canonical编译已经通过；从这里开始才判定guide模型消费行为。
  expect(
    model.requests[1]?.body.model,
    "guide模型边界：真实HTTP必须选择B。",
  ).toBe(GUIDE_MODEL_B);
  expect(second.runId, "guide模型边界：有效B不得退回新Run队列执行。").toBe(
    first.runId,
  );
  expect(await runIds(fixture, host)).toEqual([first.runId]);
  const active = await task(fixture, host);
  assertTaskIdentity(active, original, fixture, first.runId);
  const inputs = assertCanonicalSelections(active, commands, choices, host);
  expect(inputs.a.modelInvocation).toEqual(frozenA);
  expect(inputs.b.modelInvocation).toEqual(frozenB);
  expect(inputs.b).toMatchObject({
    runId: first.runId,
    status: "settled",
    intent: {
      delivery: { requested: "auto", admitted: "guide" },
      steer: { state: "guided" },
    },
  });
  const requestB = model.requests[1]?.body;
  expect(requestB?.messages).toContainEqual(
    expect.objectContaining({
      role: "assistant",
      content: guideModelText(GUIDE_MODEL_A),
    }),
  );
  expect(requestB?.messages).toContainEqual(
    expect.objectContaining({ role: "user", content: GUIDE_TEXT }),
  );
  expect(JSON.stringify(requestB?.messages).split(GUIDE_TEXT)).toHaveLength(2);
  for (const request of model.requests) {
    expect(request.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(
      request.body.messages.flatMap((message) => message.tool_calls ?? []),
    ).toEqual([]);
  }
  expect(model.requests[0]?.body.model).toBe(GUIDE_MODEL_A);
  const replayed = await host.command("sendText", payload, commands.guide);
  expect(protocol.commandAckSchema.parse(replayed.body.result)).toEqual({
    ...ack,
    status: "duplicate",
  });
  expect(model.requests).toHaveLength(2);
}

async function assertCompletedModelGuide(
  fixture: Fixture,
  host: Host,
  choices: Awaited<ReturnType<typeof qualifyModelB>>,
  prepared: Awaited<ReturnType<typeof prepareModelGuide>>,
) {
  const { first, original, commands, frozenA, frozenB } = prepared;
  const ended = await vi.waitFor(
    async () => {
      const value = await snapshot(host);
      expect(value.control).toMatchObject({
        phase: "completedSuccess",
        canStop: false,
        activeWorks: [],
      });
      expect(value.queue.items).toEqual([]);
      expect(value.pendingInteractions).toEqual([]);
      return value;
    },
    { timeout: 30_000 },
  );
  const headers = ended.rows.window.filter((row) => row.kind === "turnHeader");
  expect(headers).toHaveLength(1);
  expect(headers[0]).toMatchObject({
    turnId: first.runId,
    state: "completedSuccess",
  });
  const guided = ended.rows.window.find(
    (row) => row.kind === "userInput" && row.sourceCommandId === commands.guide,
  );
  if (guided?.kind !== "userInput" || !guided.entityId)
    throw new Error("同Run的B指导缺少稳定用户行实体ID。");
  expect(guided).toMatchObject({
    guided: true,
    turnId: first.runId,
    clientId: host.clientId,
    text: GUIDE_TEXT,
  });
  expect(
    ended.rows.window
      .filter((row) => row.kind === "assistantText")
      .map((row) => ({ turnId: row.turnId, text: row.text, state: row.state })),
  ).toEqual([
    {
      turnId: first.runId,
      text: guideModelText(GUIDE_MODEL_A),
      state: "complete",
    },
    {
      turnId: first.runId,
      text: guideModelText(GUIDE_MODEL_B),
      state: "complete",
    },
  ]);
  const settled = await task(fixture, host);
  assertTaskIdentity(settled, original, fixture, null);
  const inputs = assertCanonicalSelections(settled, commands, choices, host);
  expect(inputs.a.modelInvocation).toEqual(frozenA);
  expect(inputs.b.modelInvocation).toEqual(frozenB);
  return guided.entityId;
}

async function changeGuideProviderRevision(
  fixture: Fixture,
  host: Host,
  providerId: string,
  frozenRevision: number,
) {
  const readRevision = async () => {
    const row = await fixture.database.persistence
      .forInstance(fixture.actor.instanceId)
      .queryOne<{ config_revision: string }>(
        "select config_revision::text from public.provider_instances where instance_id=:instance and id=$1",
        [providerId],
      );
    if (!row) throw new Error("原供应商的真实配置代际不可读取。");
    return Number(row.config_revision);
  };
  const beforeRevision = await readRevision();
  expect(beforeRevision, "前置：B接收后供应商应仍是冻结时的实际代际。").toBe(
    frozenRevision,
  );
  const before = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method: "getView",
    args: [],
  });
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  const beforeView: ProviderSettingsView = before.body.result;
  const providerName = "指导模型配置变更验收";
  const changed = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method: "savePersonalProviderOverlay",
    // 原RPC的第三参数是metadata；仅改名称，不更换端点或凭据。
    args: [providerId, {}, { providerName }],
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  const changedView: ProviderSettingsView = changed.body.result;
  expect(changedView.revision).toBeGreaterThan(beforeView.revision);
  expect(
    changedView.providers.find(
      (provider) => provider.providerId === providerId,
    ),
  ).toMatchObject({
    providerName,
    credentialConfigured: true,
    executable: true,
  });
  expect(await readRevision()).toBeGreaterThan(beforeRevision);
  const reread = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method: "getView",
    args: [],
  });
  expect(reread.status).toBe(200);
  expect(reread.body.result.revision).toBe(changedView.revision);
}

async function assertFailedGuideNativePost(
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
    throw new Error("原Run的配置失败未保存实际native post。");
  const native = decodeNativeContextReference(reference.reference);
  const persistence = await fixture.app.kernel
    .get("agentPersistence")
    .getPersistence();
  if (!persistence) throw new Error("配置失败的native上下文消费者缺失。");
  const checkpoint = await persistence.checkpointer.get({
    configurable: {
      thread_id: native.threadId,
      checkpoint_ns: native.namespace,
      checkpoint_id: native.checkpointId,
    },
  });
  const messages = checkpoint?.channel_values.messages;
  if (!Array.isArray(messages)) throw new Error("配置失败后的native消息缺失。");
  const a = messages
    .filter(AIMessage.isInstance)
    .filter((message) => message.content === guideModelText(GUIDE_MODEL_A));
  expect(a).toHaveLength(1);
  expect(a[0]?.usage_metadata).toMatchObject({
    input_tokens: 10,
    output_tokens: 3,
  });
  expect(
    messages
      .filter(AIMessage.isInstance)
      .filter((message) => message.content === guideModelText(GUIDE_MODEL_B)),
  ).toEqual([]);
  expect(
    messages
      .filter(HumanMessage.isInstance)
      .filter(
        (message) =>
          message.id === guideEntityId && message.content === GUIDE_TEXT,
      ),
  ).toHaveLength(1);
}

async function assertFailedGuideUsage(
  fixture: Fixture,
  host: Host,
  runId: string,
) {
  await vi.waitFor(
    async () => {
      const usage = await summary(host);
      expect(usage.totals).toMatchObject({ inputTokens: 10, outputTokens: 3 });
      expect(usage.byModel).toHaveLength(1);
      expect(usage.byModel[0]).toMatchObject({
        provider: "instance",
        model: GUIDE_MODEL_A,
        capability: "chat",
        inputTokens: 10,
        outputTokens: 3,
      });
    },
    { timeout: 30_000 },
  );
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ model: string; input_tokens: string; output_tokens: string }>(
      `select model,sum(input_tokens)::text as input_tokens,
              sum(output_tokens)::text as output_tokens
       from public.usage_records where instance_id=:instance and run_id=$1
       group by model`,
      [runId],
    );
  expect(rows).toEqual([
    { model: GUIDE_MODEL_A, input_tokens: "10", output_tokens: "3" },
  ]);
  expect((await snapshot(host)).usage.cumulative).toMatchObject({
    inputTokens: 10,
    outputTokens: 3,
  });
}

/** 模型资格、HTTP/SSE、LocalActor、Task、PG、native graph与usage均走原公开实现。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code同Run guide切换模型 integration",
  () => {
    it("A流式期间普通UI选择有效B，下一请求同Run用B并按实际A/B用量分别落账", async () => {
      const model = await guideModelFixture();
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      try {
        fixture = await createCodeUiHttpFixture();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const choices = await qualifyModelB(host);
        expect(model.requests, "前置资格阶段不能触发模型请求。").toEqual([]);
        expect((await summary(host)).totals).toMatchObject({
          inputTokens: 0,
          outputTokens: 0,
        });
        const prepared = await prepareModelGuide(fixture, host, model, choices);
        model.finish(0);
        await assertModelBoundaryB(fixture, host, model, choices, prepared);
        model.finish(1);
        const guideId = await assertCompletedModelGuide(
          fixture,
          host,
          choices,
          prepared,
        );
        const runId = prepared.first.runId;
        await assertNativeUsage(fixture, host, runId, guideId);
        await assertUsageOwnership(
          fixture,
          host,
          runId,
          choices.selectionA.providerId,
        );
        const replayed = await host.command(
          "sendText",
          prepared.payload,
          prepared.commands.guide,
        );
        expect(protocol.commandAckSchema.parse(replayed.body.result)).toEqual({
          ...prepared.ack,
          status: "duplicate",
        });
        expect(await runIds(fixture, host)).toEqual([runId]);
        expect(model.requests).toHaveLength(2);
        await vi.waitFor(
          () =>
            expect(model.requests.map((request) => request.closed)).toEqual([
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
    }, 90_000); // 独占HTTP/PG与两段真实SSE的测试期限，非运行时治理值。

    it("B已接收后供应商配置代际改变，A正常EOF后原Run可读失败且不请求B或静默用A", async () => {
      const model = await guideModelFixture();
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      try {
        fixture = await createCodeUiHttpFixture();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const choices = await qualifyModelB(host);
        const prepared = await prepareModelGuide(fixture, host, model, choices);
        await changeGuideProviderRevision(
          fixture,
          host,
          choices.selectionB.providerId,
          prepared.frozenB.configRevision,
        );
        expect(model.requests).toHaveLength(1);
        expect(model.requests[0]?.closed).toBe(false);
        model.finish(0);
        const current = host;
        const failed = await vi.waitFor(
          async () => {
            expect(
              model.requests,
              "配置失效不得请求B或静默再请求A。",
            ).toHaveLength(1);
            const value = await snapshot(current);
            expect(value.control).toMatchObject({
              phase: "error",
              canStop: false,
              activeWorks: [],
            });
            expect(value.control.lastError?.message).toContain("配置已改变");
            expect(value.queue).toMatchObject({
              autoDrain: false,
              pauseReason: "error",
            });
            expect(value.pendingInteractions).toEqual([]);
            return value;
          },
          { timeout: 30_000 },
        );
        const guided = failed.rows.window.find(
          (row) =>
            row.kind === "userInput" &&
            row.sourceCommandId === prepared.commands.guide,
        );
        if (guided?.kind !== "userInput" || !guided.entityId)
          throw new Error("B的配置失败缺少原Run已提升的guided用户行。");
        expect(guided).toMatchObject({
          guided: true,
          turnId: prepared.first.runId,
          clientId: host.clientId,
          text: GUIDE_TEXT,
        });
        expect(
          failed.rows.window.filter((row) => row.kind === "turnHeader"),
        ).toEqual([expect.objectContaining({ turnId: prepared.first.runId })]);
        const settled = await task(fixture, host);
        assertTaskIdentity(settled, prepared.original, fixture, null);
        const inputs = assertCanonicalSelections(
          settled,
          prepared.commands,
          choices,
          host,
        );
        expect(inputs.a.modelInvocation).toEqual(prepared.frozenA);
        expect(inputs.b.modelInvocation).toEqual(prepared.frozenB);
        expect(inputs.b).toMatchObject({
          runId: prepared.first.runId,
          status: "settled",
          intent: {
            delivery: { admitted: "guide" },
            steer: { state: "guided" },
          },
        });
        expect(await runIds(fixture, host)).toEqual([prepared.first.runId]);
        await assertFailedGuideUsage(fixture, host, prepared.first.runId);
        await assertFailedGuideNativePost(
          fixture,
          host,
          prepared.first.runId,
          guided.entityId,
        );
        const reread = await snapshot(host);
        expect(reread.control.lastError).toEqual(failed.control.lastError);
        expect(reread.control.phase).toBe("error");
        expect(reread.queue).toMatchObject({
          autoDrain: false,
          pauseReason: "error",
        });
        expect(model.requests).toHaveLength(1);
        expect(model.requests[0]?.body.model).toBe(GUIDE_MODEL_A);
        expect(
          model.requests.filter(
            (request) => request.body.model === GUIDE_MODEL_B,
          ),
        ).toEqual([]);
        expect(model.requests[0]?.closed).toBe(true);
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
    }, 90_000); // 独占HTTP/PG配置失效边界的测试期限，非运行时治理值。
  },
);
