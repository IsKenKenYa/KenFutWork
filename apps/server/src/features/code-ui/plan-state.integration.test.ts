import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
  GUIDE_MODE_C_TEXT,
  GUIDE_MODE_FILE,
  GUIDE_MODE_MODEL,
  GUIDE_MODE_WRITE_CALL,
} from "./guide-mode.fixture.js";
import {
  assertActualWriteError,
  assertCycleNativePost,
  assertCycleSuccessFacts,
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
const PLAN_ON_TEXT =
  "PLAN_FLAG_ENABLE_359bdc68：只开启规划，基础模式仍为yolo。";
const PLAN_OFF_TEXT =
  "PLAN_FLAG_DISABLE_48eca293：关闭规划，基础模式仍为yolo。";
const PLAN_COLD_GUIDE_TEXT =
  "PLAN_COLD_KEEP_TRUE_73184b9e：保持已经开启的规划状态，沿同一轮继续只读。";
const PLANNING_ENABLED =
  /规划(?:模式|状态)?\s*[：:]?\s*(?:已)?(?:开启|启用)|planning(?:\s+mode)?\s*(?:is\s*)?(?:enabled|on)\b|planEnabled\s*[:=]\s*true\b/iu;

async function configureGuide(host: Host) {
  const current = await snapshot(host);
  const changed = await host.command(
    "setFollowupMode",
    { mode: "guide" },
    randomUUID(),
    {
      baseRevision: current.revision,
      baseLogEpoch: current.logEpoch,
    },
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(changed.body.result).status).toBe(
    "accepted",
  );
}

async function submitFlagGuide(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Initial,
  planEnabled: boolean,
  expectedRequests: 1 | 2,
  guideText?: string,
) {
  const before = await snapshot(host);
  const commandId = randomUUID();
  const text = guideText ?? (planEnabled ? PLAN_ON_TEXT : PLAN_OFF_TEXT);
  const payload = {
    text,
    modelSelection: initial.selected,
    mode: "yolo",
    planEnabled,
  };
  const accepted = await host.command("sendText", payload, commandId);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(accepted.body.result);
  expect(ack).toMatchObject({
    status: "accepted",
    result: { type: "inputAccepted", delivery: "queue", inputId: commandId },
  });
  const current = await task(fixture, host);
  assertTaskUnchanged(current, initial.original, fixture, initial.first.runId);
  expect(
    current.state.inputs?.find(
      (input) => input.intent.sourceCommandId === commandId,
    ),
  ).toMatchObject({
    runId: initial.first.runId,
    status: "queued",
    modelInvocation: initial.frozenA.modelInvocation,
    intent: {
      mode: "yolo",
      planEnabled,
      modelSelection: initial.selected,
      delivery: { requested: "auto", admitted: "guide" },
      steer: { state: "steering" },
    },
  });
  const held = await snapshot(host);
  expect(held.config).toMatchObject({
    mode: "yolo",
    planEnabled: before.config.planEnabled,
  });
  expect(held.queue.items).toContainEqual(
    expect.objectContaining({
      sourceCommandId: commandId,
      steer: { state: "steering" },
    }),
  );
  expect(model.requests).toHaveLength(expectedRequests);
  expect(model.requests[expectedRequests - 1]?.closed).toBe(false);
  const repeated = await host.command("sendText", payload, commandId);
  expect(protocol.commandAckSchema.parse(repeated.body.result)).toEqual({
    ...ack,
    status: "duplicate",
  });
  return { commandId, text, planEnabled };
}

async function assertFlagState(
  fixture: Fixture,
  host: Host,
  initial: Initial,
  guides: readonly Awaited<ReturnType<typeof submitFlagGuide>>[],
  planEnabled: boolean,
  activeRunId: string | null,
) {
  const current = await task(fixture, host);
  assertTaskUnchanged(current, initial.original, fixture, activeRunId);
  expect(await runIds(fixture, host)).toEqual([initial.first.runId]);
  const original = current.state.inputs?.find(
    (input) => input.intent.sourceCommandId === initial.initialCommandId,
  );
  if (!original) throw new Error("原A canonical输入缺失。");
  expect(original.intent).toEqual({
    ...initial.frozenA.intent,
    dispatch: original.intent.dispatch,
  });
  expect(original.modelInvocation).toEqual(initial.frozenA.modelInvocation);
  const value = await snapshot(host);
  // 本切片的核心：基础mode保持yolo，不能用config.mode=plan替代boolean执行状态。
  expect(value.config).toMatchObject({ mode: "yolo", planEnabled });
  expect(value.queue.items).toEqual([]);
  const ids: string[] = [];
  for (const guide of guides) {
    expect(
      current.state.inputs?.find(
        (input) => input.intent.sourceCommandId === guide.commandId,
      ),
    ).toMatchObject({
      runId: initial.first.runId,
      status: "settled",
      modelInvocation: initial.frozenA.modelInvocation,
      scopeGeneration: Number(initial.original.scope_generation),
      branchGeneration: Number(initial.original.branch_generation),
      intent: {
        mode: "yolo",
        planEnabled: guide.planEnabled,
        modelSelection: initial.selected,
        delivery: { requested: "auto", admitted: "guide" },
        steer: { state: "guided" },
      },
    });
    const row = value.rows.window.find(
      (entry) =>
        entry.kind === "userInput" && entry.sourceCommandId === guide.commandId,
    );
    if (row?.kind !== "userInput" || !row.entityId)
      throw new Error("Plan boolean指导缺少稳定原用户行。");
    expect(row).toMatchObject({
      guided: true,
      turnId: initial.first.runId,
      clientId: host.clientId,
      text: guide.text,
    });
    ids.push(row.entityId);
  }
  expect(new Set(ids).size).toBe(guides.length);
  return ids;
}

function assertPlanningPrompt(
  model: Model,
  index: number,
  enabled: boolean,
  ceiling: "yolo" | "plan" = "yolo",
) {
  assertPolicyPrompt(model, index, enabled ? "plan" : "yolo", ceiling);
  const request = model.requests[index]?.body;
  if (!request) throw new Error("Plan flag边界缺少实际模型请求。");
  const system = request.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
  if (enabled)
    expect(
      system,
      "必须显式说明规划已开启，不以基础mode=plan代替flag。",
    ).toMatch(PLANNING_ENABLED);
  else
    expect(system, "关闭flag后不能保留已开启规划的旧提示。").not.toMatch(
      PLANNING_ENABLED,
    );
}

async function assertPlanFinalFacts(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Initial,
  guides: readonly Awaited<ReturnType<typeof submitFlagGuide>>[],
  guideIds: readonly string[],
  ended: protocol.ConversationSnapshot,
) {
  expect(
    await assertFlagState(fixture, host, initial, guides, false, null),
  ).toEqual(guideIds);
  const headers = ended.rows.window.filter((row) => row.kind === "turnHeader");
  expect(headers).toHaveLength(1);
  const header = headers[0];
  if (header?.kind !== "turnHeader") throw new Error("Plan折返原轮次缺失。");
  expect(header).toMatchObject({
    turnId: initial.first.runId,
    state: "completedSuccess",
  });
  expect(header.workSegments).toHaveLength(3);
  expect(
    header.workSegments?.slice(1).map((segment) => segment.triggerEntityId),
  ).toEqual(guideIds);
  expect(
    ended.rows.window.filter((row) => row.kind === "userInput" && row.guided),
  ).toHaveLength(2);
  await assertCycleNativePost(fixture, host, initial.first.runId, guideIds, [
    PLAN_ON_TEXT,
    PLAN_OFF_TEXT,
  ]);
  await assertCycleSuccessFacts(fixture, host, model, initial.first.runId);
  expect(model.requests.map((request) => request.body.model)).toEqual([
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
  ]);
}

async function runPlanStateScenario(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const initial = await prepareYoloRun(fixture, host, model);
  await configureGuide(host);
  const enabled = await submitFlagGuide(fixture, host, model, initial, true, 1);
  model.finish(0);
  const second = await waitForPartial(host, model, 1);
  expect(second.runId, "Plan flag指导必须在原Run消费。").toBe(
    initial.first.runId,
  );
  const firstIds = await assertFlagState(
    fixture,
    host,
    initial,
    [enabled],
    true,
    initial.first.runId,
  );
  assertPlanningPrompt(model, 1, true);
  const disabled = await submitFlagGuide(
    fixture,
    host,
    model,
    initial,
    false,
    2,
  );
  model.finish(1);
  const third = await waitForPartial(host, model, 2);
  expect(third.runId).toBe(initial.first.runId);
  assertActualWriteError(model, PLAN_ON_TEXT);
  await assertErrorToolFact(fixture, host, initial.first.runId);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const guides = [enabled, disabled];
  const ids = await assertFlagState(
    fixture,
    host,
    initial,
    guides,
    false,
    initial.first.runId,
  );
  expect(ids[0]).toBe(firstIds[0]);
  assertPlanningPrompt(model, 2, false);
  expect(model.requests[2]?.body.messages).toContainEqual(
    expect.objectContaining({ role: "user", content: PLAN_OFF_TEXT }),
  );
  model.finish(2);
  const fourth = await waitForPartial(host, model, 3);
  expect(fourth.runId).toBe(initial.first.runId);
  assertPlanningPrompt(model, 3, false);
  await assertCycleSuccessFacts(fixture, host, model, initial.first.runId);
  expect(
    await assertFlagState(
      fixture,
      host,
      initial,
      guides,
      false,
      initial.first.runId,
    ),
  ).toEqual(ids);
  const ended = await finishAndWaitForCompletion(host, model, 3);
  await assertPlanFinalFacts(fixture, host, model, initial, guides, ids, ended);
  await waitForSseClosure(model, [true, true, true, true]);
}

async function assertColdPlanNative(
  fixture: Fixture,
  host: Host,
  runId: string,
  guideId: string,
) {
  const messages = await readNativePostMessages(fixture, host, runId);
  expect(
    messages
      .filter(HumanMessage.isInstance)
      .filter(
        (message) =>
          message.id === guideId && message.content === PLAN_COLD_GUIDE_TEXT,
      ),
  ).toHaveLength(1);
  const calls = messages
    .filter(AIMessage.isInstance)
    .flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.id === GUIDE_MODE_WRITE_CALL);
  expect(calls).toEqual([expect.objectContaining({ name: "Write" })]);
  const denied = messages
    .filter(ToolMessage.isInstance)
    .filter((message) => message.tool_call_id === GUIDE_MODE_WRITE_CALL);
  expect(denied).toHaveLength(1);
  expect(denied[0]?.status).toBe("error");
  expect(JSON.stringify(denied[0]?.content)).toMatch(
    /plan|只读|拒绝|权限|permission|denied/i,
  );
  expect(messages.filter(AIMessage.isInstance)).toContainEqual(
    expect.objectContaining({ content: GUIDE_MODE_C_TEXT }),
  );
}

async function assertColdPlanFinal(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Initial,
  guide: Awaited<ReturnType<typeof submitFlagGuide>>,
  guideId: string,
  ended: protocol.ConversationSnapshot,
) {
  expect(
    await assertFlagState(fixture, host, initial, [guide], true, null),
  ).toEqual([guideId]);
  const headers = ended.rows.window.filter((row) => row.kind === "turnHeader");
  expect(headers).toHaveLength(1);
  const header = headers[0];
  if (header?.kind !== "turnHeader") throw new Error("冷起点Plan原轮次缺失。");
  expect(header).toMatchObject({
    turnId: initial.first.runId,
    state: "completedSuccess",
  });
  expect(header.workSegments).toHaveLength(2);
  expect(header.workSegments?.[1]?.triggerEntityId).toBe(guideId);
  expect(
    ended.rows.window.filter((row) => row.kind === "userInput" && row.guided),
  ).toHaveLength(1);
  await assertColdPlanNative(fixture, host, initial.first.runId, guideId);
  await assertErrorToolFact(fixture, host, initial.first.runId);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(model.requests.map((request) => request.body.model)).toEqual([
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
    GUIDE_MODE_MODEL,
  ]);
  expect(await runIds(fixture, host)).toEqual([initial.first.runId]);
}

async function runColdPlanStateScenario(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const initial = await prepareYoloRun(fixture, host, model, {
    planEnabled: true,
  });
  // 原RPC yolo物理基线已通过；初始sendText本身也必须保持原mode与正交flag。
  expect(initial.frozenA.intent).toMatchObject({
    mode: "yolo",
    planEnabled: true,
  });
  expect(
    await assertFlagState(
      fixture,
      host,
      initial,
      [],
      true,
      initial.first.runId,
    ),
  ).toEqual([]);
  assertPlanningPrompt(model, 0, true, "plan");
  await configureGuide(host);
  const guide = await submitFlagGuide(
    fixture,
    host,
    model,
    initial,
    true,
    1,
    PLAN_COLD_GUIDE_TEXT,
  );
  model.finish(0);
  const second = await waitForPartial(host, model, 1);
  expect(second.runId, "冷起点同flag指导不得另起Run。").toBe(
    initial.first.runId,
  );
  assertPlanningPrompt(model, 1, true, "plan");
  const ids = await assertFlagState(
    fixture,
    host,
    initial,
    [guide],
    true,
    initial.first.runId,
  );
  const guideId = ids[0];
  if (!guideId) throw new Error("冷起点指导缺少实体ID。");
  model.finish(1);
  const third = await waitForPartial(host, model, 2);
  expect(third.runId).toBe(initial.first.runId);
  assertPlanningPrompt(model, 2, true, "plan");
  assertActualWriteError(model, PLAN_COLD_GUIDE_TEXT);
  await assertErrorToolFact(fixture, host, initial.first.runId);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await assertFlagState(
      fixture,
      host,
      initial,
      [guide],
      true,
      initial.first.runId,
    ),
  ).toEqual(ids);
  const ended = await finishAndWaitForCompletion(host, model, 2);
  await assertColdPlanFinal(
    fixture,
    host,
    model,
    initial,
    guide,
    guideId,
    ended,
  );
  await waitForSseClosure(model, [true, true, true]);
}

/** 新冷起点case尚未跑RED；不代表Plan退出审批、Enter/Exit工具或审批完成。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code正交Plan flag guide integration",
  () => {
    it("基础yolo不改，Plan flag只在模型边界开启/关闭，真实Write先拒绝再恢复且同Run结束", async () => {
      await withModeFixture(true, runPlanStateScenario);
    }, 90_000); // 独占HTTP/PG与原cycle SSE脚本期限，非运行时治理值。

    it("初始yolo+flagtrue保持正交，A/B/C同Run均有效plan与plan上限，Write正式拒绝后自然完成", async () => {
      await withModeFixture(false, runColdPlanStateScenario);
    }, 90_000); // 独占HTTP/PG与原三段SSE脚本期限，非运行时治理值。
  },
);
