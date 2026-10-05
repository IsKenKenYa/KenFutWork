import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { GUIDE_MODE_FILE, GUIDE_MODE_MODEL } from "./guide-mode.fixture.js";
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

type Initial = Awaited<ReturnType<typeof prepareYoloRun>>;
const PLAN_ALIAS_ON =
  "PLAN_ALIAS_ABSENT_ENABLE_fda12a61：只开启规划，保留原基础权限。";
const PLAN_ALIAS_OFF =
  "PLAN_ALIAS_EXPLICIT_DISABLE_802ec6d7：明确关闭规划，保留原基础权限。";

async function readPublicScope(host: Host) {
  const result = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
    undefined,
    "GET",
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(result.body).scope;
}

async function configureGuide(host: Host) {
  const value = await snapshot(host);
  const changed = await host.command(
    "setFollowupMode",
    { mode: "guide" },
    randomUUID(),
    {
      baseRevision: value.revision,
      baseLogEpoch: value.logEpoch,
    },
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(changed.body.result).status).toBe(
    "accepted",
  );
}

async function submitRawPlanGuide(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Initial,
  enabled: boolean,
  expectedRequests: number,
) {
  const before = await snapshot(host);
  const commandId = randomUUID();
  const text = enabled ? PLAN_ALIAS_ON : PLAN_ALIAS_OFF;
  const payload = {
    text,
    modelSelection: initial.selected,
    mode: "plan",
    // 第一条确实不发送planEnabled；不能把规范化后的true塞进外部请求。
    ...(!enabled ? { planEnabled: false } : {}),
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
  const input = current.state.inputs?.find(
    (entry) => entry.intent.sourceCommandId === commandId,
  );
  // 本片第一个真实RED：接纳时固定raw plan别名，canonical不能继续保存mode=plan。
  expect(input).toMatchObject({
    runId: initial.first.runId,
    status: "queued",
    modelInvocation: initial.frozenA.modelInvocation,
    scopeGeneration: Number(initial.original.scope_generation),
    branchGeneration: Number(initial.original.branch_generation),
    intent: {
      mode: "yolo",
      planEnabled: enabled,
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
      mode: "yolo",
      planEnabled: enabled,
    }),
  );
  expect(model.requests).toHaveLength(expectedRequests);
  expect(model.requests[expectedRequests - 1]?.closed).toBe(false);
  const duplicate = await host.command("sendText", payload, commandId);
  expect(protocol.commandAckSchema.parse(duplicate.body.result)).toEqual({
    ...ack,
    status: "duplicate",
  });
  if (!input) throw new Error("raw plan指导没有持久canonical输入。");
  return {
    commandId,
    text,
    enabled,
    admissionSeq: input.intent.order.admissionSeq,
  };
}

async function assertConsumed(
  fixture: Fixture,
  host: Host,
  initial: Initial,
  guides: readonly Awaited<ReturnType<typeof submitRawPlanGuide>>[],
  enabled: boolean,
  activeRunId: string | null,
) {
  const current = await task(fixture, host);
  assertTaskUnchanged(current, initial.original, fixture, activeRunId);
  expect(await runIds(fixture, host)).toEqual([initial.first.runId]);
  const input = current.state.inputs?.find(
    (entry) => entry.intent.sourceCommandId === initial.initialCommandId,
  );
  if (!input) throw new Error("raw plan指导改变后原A输入丢失。");
  expect(input.intent).toEqual({
    ...initial.frozenA.intent,
    dispatch: input.intent.dispatch,
  });
  expect(input.modelInvocation).toEqual(initial.frozenA.modelInvocation);
  expect(input.scopeGeneration).toBe(initial.frozenA.scopeGeneration);
  expect(input.branchGeneration).toBe(initial.frozenA.branchGeneration);
  const value = await snapshot(host);
  expect(value.config).toMatchObject({ mode: "yolo", planEnabled: enabled });
  expect(value.queue.items).toEqual([]);
  const ids: string[] = [];
  for (const guide of guides) {
    expect(
      current.state.inputs?.find(
        (entry) => entry.intent.sourceCommandId === guide.commandId,
      ),
    ).toMatchObject({
      runId: initial.first.runId,
      status: "settled",
      intent: {
        mode: "yolo",
        planEnabled: guide.enabled,
        steer: { state: "guided" },
      },
    });
    const row = value.rows.window.find(
      (entry) =>
        entry.kind === "userInput" && entry.sourceCommandId === guide.commandId,
    );
    if (row?.kind !== "userInput" || !row.entityId)
      throw new Error("指导缺少原稳定用户行。");
    expect(row).toMatchObject({
      guided: true,
      turnId: initial.first.runId,
      text: guide.text,
      clientId: host.clientId,
    });
    ids.push(row.entityId);
  }
  expect(new Set(ids).size).toBe(guides.length);
  return ids;
}

async function runAliasScenario(fixture: Fixture, host: Host, model: Model) {
  const initial = await prepareYoloRun(fixture, host, model);
  const scope = await readPublicScope(host);
  expect(scope.sandboxMode).toBe("danger-full-access");
  await configureGuide(host);
  const on = await submitRawPlanGuide(fixture, host, model, initial, true, 1);
  expect(await readPublicScope(host)).toEqual(scope);
  model.finish(0);
  expect((await waitForPartial(host, model, 1)).runId).toBe(
    initial.first.runId,
  );
  const firstIds = await assertConsumed(
    fixture,
    host,
    initial,
    [on],
    true,
    initial.first.runId,
  );
  assertPolicyPrompt(model, 1, "plan", "yolo");
  expect(await readPublicScope(host)).toEqual(scope);
  const off = await submitRawPlanGuide(fixture, host, model, initial, false, 2);
  expect(off.admissionSeq).toBeGreaterThan(on.admissionSeq);
  model.finish(1);
  expect((await waitForPartial(host, model, 2)).runId).toBe(
    initial.first.runId,
  );
  assertActualWriteError(model, PLAN_ALIAS_ON);
  await assertErrorToolFact(fixture, host, initial.first.runId);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const guides = [on, off];
  const ids = await assertConsumed(
    fixture,
    host,
    initial,
    guides,
    false,
    initial.first.runId,
  );
  expect(ids[0]).toBe(firstIds[0]);
  assertPolicyPrompt(model, 2, "yolo", "yolo");
  expect(await readPublicScope(host)).toEqual(scope);
  model.finish(2);
  expect((await waitForPartial(host, model, 3)).runId).toBe(
    initial.first.runId,
  );
  assertPolicyPrompt(model, 3, "yolo", "yolo");
  await assertCycleSuccessFacts(fixture, host, model, initial.first.runId);
  const ended = await finishAndWaitForCompletion(host, model, 3);
  expect(
    await assertConsumed(fixture, host, initial, guides, false, null),
  ).toEqual(ids);
  expect(await readPublicScope(host)).toEqual(scope);
  const headers = ended.rows.window.filter((row) => row.kind === "turnHeader");
  expect(headers).toHaveLength(1);
  if (headers[0]?.kind !== "turnHeader") throw new Error("原Run轮次头缺失。");
  expect(headers[0]).toMatchObject({
    turnId: initial.first.runId,
    state: "completedSuccess",
  });
  expect(
    headers[0].workSegments?.slice(1).map((segment) => segment.triggerEntityId),
  ).toEqual(ids);
  await assertCycleNativePost(
    fixture,
    host,
    initial.first.runId,
    ids,
    guides.map((guide) => guide.text),
  );
  expect(model.requests.map((request) => request.body.model)).toEqual(
    Array(4).fill(GUIDE_MODE_MODEL),
  );
  await waitForSseClosure(model, [true, true, true, true]);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原raw plan别名归一化 integration",
  () => {
    it("缺flag开规划、显式false关规划均保留yolo/物理Scope，同Run按FIFO拒绝Write后恢复", async () => {
      await withModeFixture(true, runAliasScenario);
    }, 90_000); // 独占HTTP/PG与四段真实SSE期限，非运行时治理值。
  },
);
