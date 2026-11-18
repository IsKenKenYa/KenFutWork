import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import {
  zcodeUiProtocol as protocol,
  streamEventSchema,
} from "@kenfutwork/shared";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resolveDesktopPaths } from "../../desktop/paths.js";
import { ENTER_PLAN_CALL } from "./enter-plan.fixture.js";
import {
  EXIT_PLAN_CALL,
  EXIT_PLAN_MARKDOWN,
  EXIT_PLAN_TEXTS,
  exitPlanFixture,
} from "./exit-plan.fixture.js";
import {
  GUIDE_MODE_FILE,
  GUIDE_MODE_MODEL,
  GUIDE_MODE_SUCCESS_CALL,
  GUIDE_MODE_SUCCESS_CONTENT,
} from "./guide-mode.fixture.js";
import {
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
const PLANNING_ENABLED =
  /规划(?:模式|状态)?\s*[：:]?\s*(?:已)?(?:开启|启用)|planning(?:\s+mode)?\s*(?:is\s*)?(?:enabled|on)\b|planEnabled\s*[:=]\s*true\b/iu;
// KFW宿主拥有的新字段；模型fixture从不输出、制造或预填planRef。
const planRefSchema = z.object({
  planId: z.string().min(1),
  relativePath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const exitResultSchema = z
  .object({
    approved: z.literal(true),
    plan: z.literal(EXIT_PLAN_MARKDOWN),
    mode: z.literal("yolo"),
    planEnabled: z.literal(false),
    planRef: planRefSchema,
  })
  .passthrough();
type PlanRef = z.infer<typeof planRefSchema>;

function parseModelResult(content: unknown): unknown {
  if (typeof content === "string") return JSON.parse(content);
  const blocks = z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .parse(content);
  return JSON.parse(blocks.map((block) => block.text).join("\n"));
}

function assertModelToolResult(
  model: Model,
  index: number,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  const request = model.requests[index]?.body;
  if (!request) throw new Error("缺少实际模型HTTP请求。");
  const calls = request.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.id === toolCallId);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.function.name).toBe(toolName);
  expect(JSON.parse(calls[0]?.function.arguments ?? "null")).toEqual(args);
  const results = request.messages.filter(
    (message) => message.role === "tool" && message.tool_call_id === toolCallId,
  );
  expect(results).toHaveLength(1);
  return results[0]?.content;
}

async function assertOriginalState(
  fixture: Fixture,
  host: Host,
  initial: Initial,
  planEnabled: boolean,
  activeRunId: string | null,
) {
  const current = await task(fixture, host);
  assertTaskUnchanged(current, initial.original, fixture, activeRunId);
  expect(await runIds(fixture, host)).toEqual([initial.first.runId]);
  const original = current.state.inputs?.find(
    (input) => input.intent.sourceCommandId === initial.initialCommandId,
  );
  if (!original) throw new Error("Exit审批后原A canonical输入丢失。");
  expect(original.intent).toEqual({
    ...initial.frozenA.intent,
    dispatch: original.intent.dispatch,
  });
  expect(original.modelInvocation).toEqual(initial.frozenA.modelInvocation);
  expect(original.scopeGeneration).toBe(initial.frozenA.scopeGeneration);
  expect(original.branchGeneration).toBe(initial.frozenA.branchGeneration);
  expect(current.state.inputs).toHaveLength(1);
  const value = await snapshot(host);
  expect(value.config).toMatchObject({ mode: "yolo", planEnabled });
  expect(value.queue.items).toEqual([]);
  const users = value.rows.window.filter((row) => row.kind === "userInput");
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({
    sourceCommandId: initial.initialCommandId,
    turnId: initial.first.runId,
    clientId: host.clientId,
  });
  expect(users.filter((row) => row.guided)).toEqual([]);
}

function assertPlanningPrompt(model: Model, index: number, enabled: boolean) {
  assertPolicyPrompt(model, index, enabled ? "plan" : "yolo", "yolo");
  const request = model.requests[index]?.body;
  if (!request) throw new Error("Exit缺少实际模型提示边界。");
  const system = request.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
  if (enabled) expect(system).toMatch(PLANNING_ENABLED);
  else expect(system).not.toMatch(PLANNING_ENABLED);
}

async function waitForPlanApproval(host: Host, initial: Initial) {
  return vi.waitFor(
    async () => {
      const value = await snapshot(host);
      expect(value.pendingInteractions).toHaveLength(1);
      const pending = value.pendingInteractions[0];
      if (pending?.kind !== "userInput" || pending.payload.kind !== "userInput")
        throw new Error("原V4尚未出现Exit的计划批准userInput。");
      expect(pending.payload).toMatchObject({
        toolName: "ExitPlanMode",
        toolCallId: EXIT_PLAN_CALL,
        traceId: initial.first.runId,
        schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
        input: { plan: EXIT_PLAN_MARKDOWN },
      });
      expect(pending.payload.questions).toHaveLength(1);
      const question = pending.payload.questions?.[0];
      if (!question?.question.trim())
        throw new Error("真实批准请求未提供原UI题文。");
      expect(question.options).toContainEqual(
        expect.objectContaining({ value: "approve" }),
      );
      const rows = value.rows.window.filter(
        (row) => row.kind === "toolCall" && row.toolName === "ExitPlanMode",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        toolCallId: `${initial.first.runId}/${EXIT_PLAN_CALL}`,
        status: "pendingApproval",
        input: { plan: EXIT_PLAN_MARKDOWN },
      });
      expect(pending.anchorRowId).toBe(rows[0]?.rowId);
      expect(value.config).toMatchObject({ mode: "yolo", planEnabled: true });
      expect(value.control).toMatchObject({ phase: "running", canStop: true });
      expect(value.control.activeWorks).toContainEqual(
        expect.objectContaining({
          kind: "primaryTurn",
          foregroundExecutionId: initial.first.runId,
        }),
      );
      return pending;
    },
    { timeout: 30_000 },
  );
}

async function readToolCompletions(
  fixture: Fixture,
  host: Host,
  runId: string,
) {
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ payload: unknown }>(
      `select payload from public.code_ui_events
       where instance_id=:instance and root_session_id=$1
       and payload->>'type'='tool.completed' and payload->>'runId'=$2
       order by seq`,
      [host.sessionId, runId],
    );
  return rows.map((row) => streamEventSchema.parse(row.payload));
}

async function assertApprovalJournal(
  fixture: Fixture,
  host: Host,
  initial: Initial,
  interactionId: string,
  types: readonly string[],
) {
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ payload: unknown }>(
      `select payload from public.code_ui_events
       where instance_id=:instance and root_session_id=$1
       and payload->'interaction'->>'interactionId'=$2 order by seq`,
      [host.sessionId, interactionId],
    );
  expect(rows.map((row) => row.payload)).toEqual(
    types.map((type) =>
      expect.objectContaining({
        type,
        interaction: expect.objectContaining({
          interactionId,
          kind: "userInput",
          payload: expect.objectContaining({
            toolCallId: EXIT_PLAN_CALL,
            toolName: "ExitPlanMode",
            schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
            input: { plan: EXIT_PLAN_MARKDOWN },
          }),
        }),
        identity: expect.objectContaining({
          instanceId: fixture.actor.instanceId,
          taskId: host.sessionId,
          runId: initial.first.runId,
          toolCallId: EXIT_PLAN_CALL,
          agentId: "main",
          role: "main",
          scopeGeneration: Number(initial.original.scope_generation),
          branchGeneration: Number(initial.original.branch_generation),
        }),
      }),
    ),
  );
}

async function assertManagedApproval(
  fixture: Fixture,
  host: Host,
  initial: Initial,
  ref: PlanRef,
  approvedAfter: number,
  approvedBefore: number,
) {
  const current = await task(fixture, host);
  const approved = z
    .object({
      approvedPlan: z.object({
        planRef: planRefSchema,
        taskId: z.string(),
        runId: z.string(),
        toolCallId: z.string(),
        scopeGeneration: z.number().int(),
        branchGeneration: z.number().int(),
        planningEpoch: z.number().int(),
        approvedAt: z.number().int(),
      }),
    })
    .parse(current.state).approvedPlan;
  expect(approved).toMatchObject({
    planRef: ref,
    taskId: host.sessionId,
    runId: initial.first.runId,
    toolCallId: EXIT_PLAN_CALL,
    scopeGeneration: Number(initial.original.scope_generation),
    branchGeneration: Number(initial.original.branch_generation),
    planningEpoch: 1,
  });
  expect(current.state.planningEpoch).toBe(2);
  expect(approved.approvedAt).toBeGreaterThanOrEqual(approvedAfter);
  expect(approved.approvedAt).toBeLessThanOrEqual(approvedBefore);
  const owner = await fixture.app.kernel
    .get("localInstance")
    .resolve(fixture.actor);
  expect(owner.instanceId).toBe(current.instance_id);
  expect(isAbsolute(ref.relativePath)).toBe(false);
  expect(win32.isAbsolute(ref.relativePath)).toBe(false);
  expect(ref.relativePath.split(/[\\/]/u)).not.toContain("..");
  const filesRoot = await realpath(
    resolveDesktopPaths(owner.dataDir).agentFilesDir,
  );
  const planPath = await realpath(resolve(owner.dataDir, ref.relativePath));
  const within = relative(filesRoot, planPath);
  expect(within).not.toBe("");
  expect(isAbsolute(within)).toBe(false);
  expect(within.split(sep)).not.toContain("..");
  const bytes = await readFile(planPath);
  expect(bytes.equals(Buffer.from(EXIT_PLAN_MARKDOWN, "utf8"))).toBe(true);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.sha256);
  return approved;
}

async function assertFinalFacts(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Initial,
  ref: PlanRef,
) {
  const value = await snapshot(host);
  const expected = [
    { toolName: "EnterPlanMode", toolCallId: ENTER_PLAN_CALL },
    { toolName: "ExitPlanMode", toolCallId: EXIT_PLAN_CALL },
    { toolName: "Write", toolCallId: GUIDE_MODE_SUCCESS_CALL },
  ];
  const rows = value.rows.window.filter((row) => row.kind === "toolCall");
  expect(rows).toHaveLength(3);
  expect(rows).toMatchObject(
    expected.map((entry) => ({
      ...entry,
      toolCallId: `${initial.first.runId}/${entry.toolCallId}`,
      status: "success",
    })),
  );
  const events = await readToolCompletions(fixture, host, initial.first.runId);
  expect(events).toMatchObject(
    expected.map((entry) => ({
      ...entry,
      runId: initial.first.runId,
      status: "success",
    })),
  );
  expect(events).toHaveLength(3);
  const exit = events.find(
    (event) =>
      event.type === "tool.completed" && event.toolCallId === EXIT_PLAN_CALL,
  );
  if (exit?.type !== "tool.completed")
    throw new Error("原Exit真实PG终态缺失。");
  expect(exitResultSchema.parse(exit.output).planRef).toEqual(ref);
  const native = await readNativePostMessages(
    fixture,
    host,
    initial.first.runId,
  );
  const humans = native.filter(HumanMessage.isInstance);
  expect(humans).toHaveLength(1);
  expect(humans[0]?.content).toBe(initial.frozenA.intent.text);
  const tools = native.filter(ToolMessage.isInstance);
  expect(tools).toHaveLength(3);
  expect(tools).toMatchObject(
    expected.map((entry) => ({
      tool_call_id: entry.toolCallId,
      status: "success",
    })),
  );
  const exitNative = tools.find(
    (message) => message.tool_call_id === EXIT_PLAN_CALL,
  );
  expect(
    exitResultSchema.parse(parseModelResult(exitNative?.content)).planRef,
  ).toEqual(ref);
  expect(native.filter(AIMessage.isInstance)).toContainEqual(
    expect.objectContaining({ content: EXIT_PLAN_TEXTS[3] }),
  );
  const modelExit = assertModelToolResult(
    model,
    3,
    EXIT_PLAN_CALL,
    "ExitPlanMode",
    { plan: EXIT_PLAN_MARKDOWN },
  );
  expect(exitResultSchema.parse(parseModelResult(modelExit)).planRef).toEqual(
    ref,
  );
}

async function rejectEmptyAcceptance(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Initial,
  pending: Awaited<ReturnType<typeof waitForPlanApproval>>,
) {
  await assertApprovalJournal(fixture, host, initial, pending.interactionId, [
    "requested",
  ]);
  const invalid = await host.command("resolveInteraction", {
    interactionId: pending.interactionId,
    answer: { action: "accept", content: {} },
  });
  expect(invalid.status, JSON.stringify(invalid.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(invalid.body.result).status).toBe(
    "rejected",
  );
  expect(await waitForPlanApproval(host, initial)).toEqual(pending);
  await assertOriginalState(fixture, host, initial, true, initial.first.runId);
  expect(model.requests).toHaveLength(2);
  await assertApprovalJournal(fixture, host, initial, pending.interactionId, [
    "requested",
  ]);
  const completed = await readToolCompletions(
    fixture,
    host,
    initial.first.runId,
  );
  expect(
    completed.filter(
      (event) =>
        event.type === "tool.completed" && event.toolCallId === EXIT_PLAN_CALL,
    ),
  ).toEqual([]);
  const beforeApproval = (await task(fixture, host)).state;
  expect(
    z.object({ approvedPlan: z.unknown().optional() }).parse(beforeApproval)
      .approvedPlan ?? null,
  ).toBeNull();
}

async function approveExitPlan(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Initial,
  pending: Awaited<ReturnType<typeof waitForPlanApproval>>,
) {
  // 原V4 schema只有业务标记，答案键必须读取真实payload.questions题文。
  if (pending.payload.kind !== "userInput")
    throw new Error("计划批准payload类型失效。");
  const question = pending.payload.questions?.[0]?.question;
  if (!question) throw new Error("原批准请求题文缺失。");
  const approvedAfter = Date.now();
  const approved = await host.command("resolveInteraction", {
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
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(approved.body.result).status).toBe(
    "accepted",
  );
  const third = await waitForPartial(host, model, 2);
  const approvedBefore = Date.now();
  expect(third.runId).toBe(initial.first.runId);
  assertPlanningPrompt(model, 2, false);
  await assertOriginalState(fixture, host, initial, false, initial.first.runId);
  const actualExit = assertModelToolResult(
    model,
    2,
    EXIT_PLAN_CALL,
    "ExitPlanMode",
    { plan: EXIT_PLAN_MARKDOWN },
  );
  const result = exitResultSchema.parse(parseModelResult(actualExit));
  const approvedFact = await assertManagedApproval(
    fixture,
    host,
    initial,
    result.planRef,
    approvedAfter,
    approvedBefore,
  );
  await assertApprovalJournal(fixture, host, initial, pending.interactionId, [
    "requested",
    "resolved",
  ]);
  return { result, approvedFact, approvedAfter, approvedBefore };
}

async function prepareExitApproval(fixture: Fixture, host: Host, model: Model) {
  const initial = await prepareYoloRun(fixture, host, model);
  expect(
    model.requests[0]?.body.tools?.map((tool) => tool.function.name),
  ).toContain("EnterPlanMode");
  model.finish(0);
  const second = await waitForPartial(host, model, 1);
  expect(second.runId).toBe(initial.first.runId);
  assertModelToolResult(model, 1, ENTER_PLAN_CALL, "EnterPlanMode", {});
  assertPlanningPrompt(model, 1, true);
  expect(
    model.requests[1]?.body.tools?.map((tool) => tool.function.name),
  ).toContain("ExitPlanMode");
  await assertOriginalState(fixture, host, initial, true, initial.first.runId);
  model.finish(1);
  const pending = await waitForPlanApproval(host, initial);
  expect((await snapshot(host)).pendingInteractions).toEqual([pending]);
  await waitForSseClosure(model, [true, true]);
  expect(model.requests).toHaveLength(2);
  await rejectEmptyAcceptance(fixture, host, model, initial, pending);
  return { initial, pending };
}

async function runExitApprovalScenario(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const { initial, pending } = await prepareExitApproval(fixture, host, model);
  const approval = await approveExitPlan(
    fixture,
    host,
    model,
    initial,
    pending,
  );
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  model.finish(2);
  const fourth = await waitForPartial(host, model, 3);
  expect(fourth.runId).toBe(initial.first.runId);
  assertPlanningPrompt(model, 3, false);
  assertModelToolResult(model, 3, GUIDE_MODE_SUCCESS_CALL, "Write", {
    file_path: GUIDE_MODE_FILE,
    content: GUIDE_MODE_SUCCESS_CONTENT,
  });
  expect(
    await readFile(join(host.workspacePath, GUIDE_MODE_FILE), "utf8"),
  ).toBe(GUIDE_MODE_SUCCESS_CONTENT);
  const ended = await finishAndWaitForCompletion(host, model, 3);
  await assertOriginalState(fixture, host, initial, false, null);
  expect(ended.rows.window.filter((row) => row.kind === "turnHeader")).toEqual([
    expect.objectContaining({
      turnId: initial.first.runId,
      state: "completedSuccess",
    }),
  ]);
  await assertFinalFacts(
    fixture,
    host,
    model,
    initial,
    approval.result.planRef,
  );
  expect(
    await assertManagedApproval(
      fixture,
      host,
      initial,
      approval.result.planRef,
      approval.approvedAfter,
      approval.approvedBefore,
    ),
  ).toEqual(approval.approvedFact);
  expect(model.requests.map((request) => request.body.model)).toEqual(
    Array(4).fill(GUIDE_MODE_MODEL),
  );
  await waitForSseClosure(model, [true, true, true, true]);
}

/** 主Run批准与真实保存失败切片；拒绝/取消/冷恢复/压缩是后续独立案例。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code原ExitPlanMode批准公开宿主 integration",
  () => {
    it("空accept拒绝且仍等待，真实人答批准管理文件后同Run原Write成功并自然结束", async () => {
      await withModeFixture(false, runExitApprovalScenario, exitPlanFixture);
    }, 90_000); // 独占HTTP/PG与四段真实SSE期限，非运行时治理值。
    it("真实管理目录不可写时明确失败，仍保持规划且不发布批准文件事实", async () => {
      await withModeFixture(
        false,
        async (fixture, host, model) => {
          const { initial, pending } = await prepareExitApproval(
            fixture,
            host,
            model,
          );
          const owner = await fixture.app.kernel
            .get("localInstance")
            .resolve(fixture.actor);
          const files = resolveDesktopPaths(owner.dataDir).agentFilesDir;
          await mkdir(files, { recursive: true });
          await writeFile(join(files, "plans"), "真实文件阻止目录创建\n", {
            flag: "wx",
          });
          if (pending.payload.kind !== "userInput")
            throw new Error("计划payload类型失效。");
          const question = pending.payload.questions?.[0]?.question;
          if (!question) throw new Error("缺少真实批准题文。");
          const response = await host.command("resolveInteraction", {
            interactionId: pending.interactionId,
            answer: {
              action: "accept",
              content: { answers: { [question]: "approve" } },
            },
          });
          expect(response.status).toBe(200);
          const third = await waitForPartial(host, model, 2);
          expect(third.runId).toBe(initial.first.runId);
          assertPlanningPrompt(model, 2, true);
          const errorResult = assertModelToolResult(
            model,
            2,
            EXIT_PLAN_CALL,
            "ExitPlanMode",
            { plan: EXIT_PLAN_MARKDOWN },
          );
          expect(JSON.stringify(errorResult)).toMatch(
            /EEXIST|ENOTDIR|directory|目录/i,
          );
          const failed = await snapshot(host);
          expect(failed.config.planEnabled).toBe(true);
          expect(failed.pendingInteractions).toEqual([]);
          const current = await task(fixture, host);
          expect(current.state.approvedPlan).toBeUndefined();
          expect(current.state.planningEpoch).toBe(1);
          expect(model.requests).toHaveLength(3);
          const facts = await readToolCompletions(
            fixture,
            host,
            initial.first.runId,
          );
          expect(
            facts.filter(
              (event) =>
                event.type === "tool.completed" &&
                event.toolCallId === EXIT_PLAN_CALL &&
                event.status === "success",
            ),
          ).toEqual([]);
          await expect(
            readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
          ).rejects.toMatchObject({ code: "ENOENT" });
          model.finish(2);
          await waitForPartial(host, model, 3);
          assertPlanningPrompt(model, 3, true);
          await finishAndWaitForCompletion(host, model, 3);
          await assertOriginalState(fixture, host, initial, true, null);
          await expect(
            readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            (await task(fixture, host)).state.approvedPlan,
          ).toBeUndefined();
          await waitForSseClosure(model, [true, true, true, true]);
        },
        exitPlanFixture,
      );
    }, 90_000);
  },
);
