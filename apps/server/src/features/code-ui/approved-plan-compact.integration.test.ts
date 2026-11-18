import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import {
  zcodeUiProtocol as protocol,
  streamEventSchema,
} from "@kenfutwork/shared";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { effectiveNativeMessages } from "../../agent/native-context-history.js";
import { resolveDesktopPaths } from "../../desktop/paths.js";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import {
  approvedPlanCompactFixture,
  PLAN_COMPACT_CONTINUE,
  PLAN_COMPACT_CONTINUE_INDEX,
  PLAN_COMPACT_FILLER_TURNS,
  PLAN_COMPACT_SUMMARY,
  PLAN_COMPACT_SUMMARY_INDEX,
  PLAN_COMPACT_TEXTS,
} from "./approved-plan-compact.fixture.js";
import { ENTER_PLAN_CALL } from "./enter-plan.fixture.js";
import { EXIT_PLAN_CALL, EXIT_PLAN_MARKDOWN } from "./exit-plan.fixture.js";
import {
  assertPolicyPrompt,
  assertTaskUnchanged,
  type Fixture,
  finishAndWaitForCompletion,
  type Host,
  type Model,
  prepareYoloRun,
  readNativeBoundaryState,
  readNativePostMessages,
  snapshot,
  task,
  waitForPartial,
  waitForSseClosure,
  withModeFixture,
} from "./guide-state-test.fixture.js";
import type { CodeApprovedPlan } from "./planning-types.js";

type Initial = Awaited<ReturnType<typeof prepareYoloRun>>;
type Approved = {
  initial: Initial;
  fact: CodeApprovedPlan;
  epoch: number;
};
const exitResultSchema = z.object({
  approved: z.literal(true),
  plan: z.literal(EXIT_PLAN_MARKDOWN),
  mode: z.literal("yolo"),
  planEnabled: z.literal(false),
  planRef: z.object({
    planId: z.string().min(1),
    relativePath: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
});

function parseModelResult(content: unknown): unknown {
  if (typeof content === "string") return JSON.parse(content);
  const blocks = z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .parse(content);
  return JSON.parse(blocks.map((block) => block.text).join("\n"));
}

function modelText(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = z
    .array(
      z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
    )
    .parse(content);
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

async function assertManagedPlan(
  fixture: Fixture,
  host: Host,
  fact: CodeApprovedPlan,
) {
  const owner = await fixture.app.kernel
    .get("localInstance")
    .resolve(fixture.actor);
  expect(fact).toMatchObject({
    instanceId: owner.instanceId,
    taskId: host.sessionId,
    toolCallId: EXIT_PLAN_CALL,
    role: "main",
    agentId: "main",
  });
  const ref = fact.planRef;
  expect(isAbsolute(ref.relativePath)).toBe(false);
  expect(win32.isAbsolute(ref.relativePath)).toBe(false);
  expect(ref.relativePath.split(/[\\/]/u)).not.toContain("..");
  const root = await realpath(resolveDesktopPaths(owner.dataDir).agentFilesDir);
  const file = await realpath(resolve(owner.dataDir, ref.relativePath));
  const suffix = relative(root, file);
  expect(suffix).not.toBe("");
  expect(isAbsolute(suffix)).toBe(false);
  expect(suffix.split(sep)).not.toContain("..");
  const bytes = await readFile(file);
  expect(bytes.equals(Buffer.from(EXIT_PLAN_MARKDOWN, "utf8"))).toBe(true);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.sha256);
}

async function assertApprovalAuthority(
  fixture: Fixture,
  host: Host,
  fact: CodeApprovedPlan,
) {
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ parameter_fingerprint: string; payload: unknown }>(
      `select parameter_fingerprint, payload from public.code_ui_events
       where instance_id=:instance and root_session_id=$1
       and payload->>'type'='plan.approved' order by seq`,
      [host.sessionId],
    );
  expect(rows).toHaveLength(1);
  const event = z.record(z.string(), z.unknown()).parse(rows[0]?.payload);
  expect(event).toMatchObject({
    type: "plan.approved",
    instanceId: fact.instanceId,
    taskId: host.sessionId,
    runId: fact.runId,
    toolCallId: EXIT_PLAN_CALL,
    role: "main",
    agentId: "main",
    scopeGeneration: fact.scopeGeneration,
    branchGeneration: fact.branchGeneration,
    planningEpoch: fact.planningEpoch,
    planRef: fact.planRef,
  });
  expect(rows[0]?.parameter_fingerprint).toBe(
    parameterFingerprint({ ...event, plan: EXIT_PLAN_MARKDOWN }),
  );
}

async function assertStable(
  fixture: Fixture,
  host: Host,
  approved: Approved,
  activeRunId: string | null,
) {
  const current = await task(fixture, host);
  assertTaskUnchanged(current, approved.initial.original, fixture, activeRunId);
  expect(current.state.approvedPlan).toEqual(approved.fact);
  expect(current.state.planningEpoch).toBe(approved.epoch);
  const initial = current.state.inputs?.find(
    (input) =>
      input.intent.sourceCommandId === approved.initial.initialCommandId,
  );
  if (!initial) throw new Error("compact续轮丢失原canonical A。");
  expect(initial.intent).toEqual({
    ...approved.initial.frozenA.intent,
    dispatch: initial.intent.dispatch,
  });
  expect(initial.modelInvocation).toEqual(
    approved.initial.frozenA.modelInvocation,
  );
  expect(initial.scopeGeneration).toBe(
    approved.initial.frozenA.scopeGeneration,
  );
  expect(initial.branchGeneration).toBe(
    approved.initial.frozenA.branchGeneration,
  );
  const value = await snapshot(host);
  expect(value.config).toMatchObject({ mode: "yolo", planEnabled: false });
  expect(
    value.rows.window.filter((row) => row.kind === "userInput" && row.guided),
  ).toEqual([]);
  await assertManagedPlan(fixture, host, approved.fact);
  await assertApprovalAuthority(fixture, host, approved.fact);
}

async function prepareApproved(
  fixture: Fixture,
  host: Host,
  model: Model,
): Promise<Approved> {
  const initial = await prepareYoloRun(fixture, host, model);
  expect(
    model.requests[0]?.body.tools?.map((tool) => tool.function.name),
  ).toContain("EnterPlanMode");
  model.finish(0);
  expect((await waitForPartial(host, model, 1)).runId).toBe(
    initial.first.runId,
  );
  assertPolicyPrompt(model, 1, "plan", "yolo");
  expect((await snapshot(host)).config).toMatchObject({
    mode: "yolo",
    planEnabled: true,
  });
  model.finish(1);
  const pending = await vi.waitFor(
    async () => {
      const interaction = (await snapshot(host)).pendingInteractions.find(
        (entry) =>
          entry.kind === "userInput" &&
          entry.payload.kind === "userInput" &&
          entry.payload.toolCallId === EXIT_PLAN_CALL,
      );
      if (interaction?.payload.kind !== "userInput")
        throw new Error("真实Exit计划批准尚未出现。");
      expect(interaction.payload).toMatchObject({
        input: { plan: EXIT_PLAN_MARKDOWN },
        schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
      });
      return interaction;
    },
    { timeout: 30_000 },
  );
  if (pending.payload.kind !== "userInput")
    throw new Error("批准计划payload类型失效。");
  const question = pending.payload.questions?.[0]?.question;
  if (!question) throw new Error("真实批准题文缺失。");
  const answered = await host.command("resolveInteraction", {
    interactionId: pending.interactionId,
    answer: {
      action: "accept",
      content: {
        answers: { [question]: "approve" },
        answer_0: "approve",
        answer: "approve",
      },
    },
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(answered.body.result).status).toBe(
    "accepted",
  );
  expect((await waitForPartial(host, model, 2)).runId).toBe(
    initial.first.runId,
  );
  const request = model.requests[2]?.body;
  const calls = request?.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.id === EXIT_PLAN_CALL);
  expect(calls).toHaveLength(1);
  expect(calls?.[0]?.function.name).toBe("ExitPlanMode");
  expect(JSON.parse(calls?.[0]?.function.arguments ?? "null")).toEqual({
    plan: EXIT_PLAN_MARKDOWN,
  });
  const results = request?.messages.filter(
    (message) =>
      message.role === "tool" && message.tool_call_id === EXIT_PLAN_CALL,
  );
  expect(results).toHaveLength(1);
  const result = exitResultSchema.parse(
    parseModelResult(results?.[0]?.content),
  );
  await finishAndWaitForCompletion(host, model, 2);
  const current = await task(fixture, host);
  const fact = current.state.approvedPlan;
  if (!fact) throw new Error("原Task未持久保存真实批准事实。");
  expect(fact.planRef).toEqual(result.planRef);
  expect(fact.runId).toBe(initial.first.runId);
  const approved = {
    initial,
    fact: structuredClone(fact),
    epoch: current.state.planningEpoch ?? 0,
  };
  await assertStable(fixture, host, approved, null);
  const native = await readNativePostMessages(
    fixture,
    host,
    initial.first.runId,
  );
  expect(
    native
      .filter(ToolMessage.isInstance)
      .map((message) => ({ id: message.tool_call_id, status: message.status })),
  ).toEqual([
    { id: ENTER_PLAN_CALL, status: "success" },
    { id: EXIT_PLAN_CALL, status: "success" },
  ]);
  return approved;
}

async function seedPublicHistory(
  fixture: Fixture,
  host: Host,
  model: Model,
  approved: Approved,
) {
  const runIds = [approved.fact.runId];
  for (let index = 0; index < PLAN_COMPACT_FILLER_TURNS; index += 1) {
    const commandId = randomUUID();
    const sent = await host.command(
      "sendText",
      {
        text: `PLAN_COMPACT_FILLER_USER_${index}_9ebeb1bd`,
        modelSelection: approved.initial.selected,
        mode: "yolo",
        planEnabled: false,
      },
      commandId,
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
      "accepted",
    );
    const partial = await waitForPartial(host, model, index + 3);
    expect(runIds).not.toContain(partial.runId);
    runIds.push(partial.runId);
    await finishAndWaitForCompletion(host, model, index + 3);
    await assertStable(fixture, host, approved, null);
  }
  return runIds;
}

async function compactActual(
  fixture: Fixture,
  host: Host,
  model: Model,
  approved: Approved,
) {
  const commandId = randomUUID();
  const sent = await host.command("compact", {}, commandId);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  const runId = await vi.waitFor(
    async () => {
      expect(model.requests).toHaveLength(PLAN_COMPACT_SUMMARY_INDEX + 1);
      const input = (await task(fixture, host)).state.inputs?.find(
        (entry) => entry.intent.sourceCommandId === commandId,
      );
      if (!input) throw new Error("真实compact持久输入尚未出现。");
      expect(input).toMatchObject({
        status: "active",
        intent: { kind: "compact", text: "" },
      });
      expect((await snapshot(host)).rows.window).toContainEqual(
        expect.objectContaining({
          entityId: `compact:${input.runId}`,
          kind: "timelineMarker",
          marker: { type: "compact", origin: "manual", status: "running" },
        }),
      );
      return input.runId;
    },
    { timeout: 30_000 },
  );
  const pre = await readNativeBoundaryState(fixture, host, runId, "pre");
  expect(pre.boundary).toMatchObject({
    operation: { kind: "compact" },
    inputOrigin: "controlOperation",
    inputIdentity: { clientId: host.clientId, sourceCommandId: commandId },
  });
  if (!Array.isArray(pre.state.messages))
    throw new Error("compact pre原生消息缺失。");
  const before = effectiveNativeMessages(pre.state.messages, pre.state);
  expect(
    before
      .filter(ToolMessage.isInstance)
      .map((message) => message.tool_call_id),
  ).toContain(EXIT_PLAN_CALL);
  await finishAndWaitForCompletion(host, model, PLAN_COMPACT_SUMMARY_INDEX);
  const post = await vi.waitFor(
    () => readNativeBoundaryState(fixture, host, runId, "post"),
    { timeout: 30_000 },
  );
  expect(post.boundary.context).not.toEqual(pre.boundary.context);
  if (!Array.isArray(post.state.messages))
    throw new Error("compact post原生消息缺失。");
  const effective = effectiveNativeMessages(post.state.messages, post.state);
  expect(effective.length).toBeLessThan(before.length);
  expect(
    effective
      .filter(HumanMessage.isInstance)
      .filter(
        (message) => message.additional_kwargs.lc_source === "summarization",
      ),
  ).toHaveLength(1);
  expect(JSON.stringify(effective)).toContain(PLAN_COMPACT_SUMMARY);
  expect(
    effective
      .filter(ToolMessage.isInstance)
      .map((message) => message.tool_call_id),
  ).not.toContain(EXIT_PLAN_CALL);
  expect(
    effective
      .filter(AIMessage.isInstance)
      .flatMap((message) => message.tool_calls ?? [])
      .filter((call) => call.id === EXIT_PLAN_CALL),
  ).toEqual([]);
  // 多行正文在JSON中会转义换行；用唯一原标题和ref值锁实质排除，避免空断言。
  for (const value of [
    EXIT_PLAN_MARKDOWN.split("\n")[0],
    approved.fact.planRef.planId,
    approved.fact.planRef.relativePath,
    approved.fact.planRef.sha256,
  ])
    expect(JSON.stringify(effective)).not.toContain(value);
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ payload: unknown }>(
      `select payload from public.code_ui_events where instance_id=:instance and root_session_id=$1
     and payload->>'runId'=$2 and payload->>'type' in ('run.compacted','run.completed') order by seq`,
      [host.sessionId, runId],
    );
  expect(rows.map((row) => streamEventSchema.parse(row.payload))).toMatchObject(
    [
      { type: "run.compacted", origin: "manual", runId },
      {
        type: "run.completed",
        runId,
        operationResult: { kind: "compact", status: "applied" },
      },
    ],
  );
  const refreshed = await readNativeBoundaryState(fixture, host, runId, "pre");
  expect(refreshed.state.messages).toEqual(pre.state.messages);
  await assertStable(fixture, host, approved, null);
  expect(
    (await snapshot(host)).rows.window.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "compact",
    ),
  ).toEqual([
    expect.objectContaining({
      entityId: `compact:${runId}`,
      marker: { type: "compact", origin: "manual", status: "success" },
    }),
  ]);
  return runId;
}

async function continueNewRun(
  fixture: Fixture,
  host: Host,
  model: Model,
  approved: Approved,
  previousRuns: string[],
) {
  const commandId = randomUUID();
  const sent = await host.command(
    "sendText",
    {
      text: PLAN_COMPACT_CONTINUE,
      modelSelection: approved.initial.selected,
      mode: "yolo",
      planEnabled: false,
    },
    commandId,
  );
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  const partial = await waitForPartial(
    host,
    model,
    PLAN_COMPACT_CONTINUE_INDEX,
  );
  expect(previousRuns).not.toContain(partial.runId);
  await assertStable(fixture, host, approved, partial.runId);
  const request = model.requests[PLAN_COMPACT_CONTINUE_INDEX]?.body;
  if (!request) throw new Error("compact后没有新Run真实HTTP请求。");
  expect(
    JSON.stringify(
      request.messages.filter(
        (message) => message.role !== "system" && message.role !== "developer",
      ),
    ),
  ).toContain(PLAN_COMPACT_SUMMARY);
  expect(
    request.messages.filter(
      (message) =>
        message.role === "tool" && message.tool_call_id === EXIT_PLAN_CALL,
    ),
  ).toEqual([]);
  expect(
    request.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.tool_calls ?? [])
      .filter((call) => call.id === EXIT_PLAN_CALL),
  ).toEqual([]);
  const system = request.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map((message) => modelText(message.content))
    .join("\n");
  // 唯一预期消费RED：旧结果和摘要均无计划后，真正新请求仍须带owner重读正文/ref。
  expect(system).toContain(EXIT_PLAN_MARKDOWN);
  for (const value of Object.values(approved.fact.planRef))
    expect(system).toContain(value);
  assertPolicyPrompt(model, PLAN_COMPACT_CONTINUE_INDEX, "yolo", "yolo");
  await finishAndWaitForCompletion(host, model, PLAN_COMPACT_CONTINUE_INDEX);
  await assertStable(fixture, host, approved, null);
  const native = await vi.waitFor(
    () => readNativeBoundaryState(fixture, host, partial.runId, "post"),
    { timeout: 30_000 },
  );
  expect(native.boundary).toMatchObject({
    runId: partial.runId,
    inputOrigin: "userInput",
    inputIdentity: { clientId: host.clientId, sourceCommandId: commandId },
    taskId: host.sessionId,
    instanceId: fixture.actor.instanceId,
    branchGeneration: approved.fact.branchGeneration,
  });
  if (!Array.isArray(native.state.messages))
    throw new Error("续轮native post消息缺失。");
  const effective = effectiveNativeMessages(
    native.state.messages,
    native.state,
  );
  expect(
    effective
      .filter(HumanMessage.isInstance)
      .filter((message) => message.content === PLAN_COMPACT_CONTINUE),
  ).toHaveLength(1);
  expect(effective.filter(AIMessage.isInstance)).toContainEqual(
    expect.objectContaining({
      content: PLAN_COMPACT_TEXTS[PLAN_COMPACT_CONTINUE_INDEX],
    }),
  );
  expect(
    (await snapshot(host)).rows.window
      .filter((row) => row.kind === "userInput")
      .map((row) => row.text),
  ).toHaveLength(PLAN_COMPACT_FILLER_TURNS + 2);
  const completed = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ payload: unknown }>(
      `select payload from public.code_ui_events where instance_id=:instance and root_session_id=$1
     and payload->>'type'='run.completed' and payload->>'runId'=$2 order by seq`,
      [host.sessionId, partial.runId],
    );
  expect(completed.map((row) => streamEventSchema.parse(row.payload))).toEqual([
    expect.objectContaining({ type: "run.completed", runId: partial.runId }),
  ]);
  await waitForSseClosure(model, Array(PLAN_COMPACT_TEXTS.length).fill(true));
}

async function runCompactScenario(fixture: Fixture, host: Host, model: Model) {
  const approved = await prepareApproved(fixture, host, model);
  const runs = await seedPublicHistory(fixture, host, model, approved);
  const compact = await compactActual(fixture, host, model, approved);
  expect(runs).not.toContain(compact);
  runs.push(compact);
  await continueNewRun(fixture, host, model, approved, runs);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "批准计划真实compact续轮 integration",
  () => {
    it("旧Exit从有效历史移除且摘要不带plan/ref，新Run模型请求仍消费owner核验的批准计划", async () => {
      await withModeFixture(
        false,
        runCompactScenario,
        approvedPlanCompactFixture,
      );
    }, 120_000); // 独占HTTP/PG、公开filler与真实compact期限，非运行时治理值。
    it("压缩后管理计划被篡改，新Run正式失败且零模型请求，不借旧转录或缓存继续", async () => {
      await withModeFixture(
        false,
        async (fixture, host, model) => {
          const approved = await prepareApproved(fixture, host, model);
          await seedPublicHistory(fixture, host, model, approved);
          await compactActual(fixture, host, model, approved);
          const owner = await fixture.app.kernel
            .get("localInstance")
            .resolve(fixture.actor);
          await writeFile(
            resolve(owner.dataDir, approved.fact.planRef.relativePath),
            "# 未获批准的篡改内容\n",
          );
          const sent = await host.command("sendText", {
            text: PLAN_COMPACT_CONTINUE,
            modelSelection: approved.initial.selected,
            mode: "yolo",
            planEnabled: false,
          });
          expect(sent.status).toBe(200);
          const failed = await vi.waitFor(
            async () => {
              const value = await snapshot(host);
              expect(value.control).toMatchObject({
                phase: "error",
                activeWorks: [],
                canStop: false,
              });
              expect(value.control.lastError?.message).toMatch(
                /批准计划.*哈希.*改变/u,
              );
              expect(value.pendingInteractions).toEqual([]);
              return value;
            },
            { timeout: 30_000 },
          );
          expect(failed.config).toMatchObject({
            mode: "yolo",
            planEnabled: false,
          });
          expect(model.requests).toHaveLength(PLAN_COMPACT_CONTINUE_INDEX);
          const current = await task(fixture, host);
          assertTaskUnchanged(
            current,
            approved.initial.original,
            fixture,
            null,
          );
          expect(current.state.approvedPlan).toEqual(approved.fact);
          expect(current.state.planningEpoch).toBe(2);
          await waitForSseClosure(
            model,
            Array(PLAN_COMPACT_CONTINUE_INDEX).fill(true),
          );
        },
        approvedPlanCompactFixture,
      );
    }, 120_000);
  },
);
