import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { decodeNativeContextReference } from "../../agent/native-context-reference.js";
import {
  GUIDE_MODE_C_TEXT,
  GUIDE_MODE_FILE,
  GUIDE_MODE_FILE_CONTENT,
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
  runIds,
  snapshot,
  task,
  waitForPartial,
  waitForSseClosure,
  withModeFixture,
} from "./guide-state-test.fixture.js";

const GUIDE_TEXT =
  "GUIDE_MODE_PLAN_ONLY_04bc70e1：从下一模型边界保持只读plan。";
const RESTORE_GUIDE_TEXT =
  "GUIDE_MODE_YOLO_RESTORE_ba1f7c63：从下一模型边界恢复yolo。";

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
    planEnabled: true,
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
    mode: "yolo",
    planEnabled: true,
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
      mode: "yolo",
      planEnabled: true,
      delivery: { requested: "auto", admitted: "guide" },
      steer: { state: "guided" },
    },
  });
  expect(guide.modelInvocation).toEqual(prepared.frozenA.modelInvocation);
  const value = await snapshot(host);
  expect(value.config).toMatchObject({ mode: "yolo", planEnabled: true });
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
  expect(held.config).toMatchObject({ mode: "yolo", planEnabled: true });
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
        mode: "yolo",
        planEnabled: index === 0,
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
  await assertCycleNativePost(fixture, host, prepared.first.runId, guideIds, [
    GUIDE_TEXT,
    RESTORE_GUIDE_TEXT,
  ]);
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
  assertActualWriteError(model, GUIDE_TEXT);
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
  assertActualWriteError(model, GUIDE_TEXT);
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
  "Code同Run原plan别名guide integration",
  () => {
    it("yolo正文后原plan别名开启独立规划，恶意Write正式拒绝且C同Run自然结束", async () => {
      await withModeFixture(false, runPlanGuideScenario);
    }, 90_000); // 独占HTTP/PG与三段SSE同步期限，非运行时治理值。

    it("同Run yolo→plan→yolo折返，B写入真实拒绝而C新Write真实成功，D自然完成", async () => {
      await withModeFixture(true, runModeCycleScenario);
    }, 90_000); // 独占HTTP/PG与四段真实SSE的测试期限，非运行时治理值。
  },
);
