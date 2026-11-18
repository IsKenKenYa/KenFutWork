import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  assertTaskUnchanged,
  type Fixture,
  type Host,
  readNativePostMessages,
  runIds,
  snapshot,
  task,
} from "./guide-state-test.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { modelRequestSchema } from "./user-question-model.fixture.js";

// 实际.app失败的原指令：24个Unicode码点，第24个UTF-16码元恰是🚀的高代理项。
const INPUT_TEXT = "观察第一方验收窗口，截屏并输入Task中文🙂🚀。";
type Model = Awaited<ReturnType<typeof heldModel>>;

async function observeUnicodeRun(
  fixture: Fixture,
  host: Host,
  model: Model,
  text: string,
  title: string,
) {
  const original = await task(fixture, host);
  const commandId = randomUUID();
  const payload = { text: text };
  const sent = await host.command("sendText", payload, commandId);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(sent.body.result);
  expect(ack.status).toBe("accepted");
  const running = await vi.waitFor(
    async () => {
      expect(model.requests).toHaveLength(1);
      const value = await snapshot(host);
      expect(value.control.phase).toBe("running");
      expect(value.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          text: "正在运行 1",
          state: "streaming",
        }),
      );
      return value;
    },
    { timeout: 30_000 },
  ); // 真实HTTP/SSE同步期限，非运行时治理值。
  const primary = running.control.activeWorks.filter(
    (work) => work.kind === "primaryTurn",
  );
  expect(primary).toHaveLength(1);
  const runId = primary[0]?.foregroundExecutionId;
  if (!runId) throw new Error("Unicode输入没有真实活动Run。");
  expect(running.meta).toMatchObject({
    title,
    titleSource: "generated",
  });
  expect(running.rows.window.filter((row) => row.kind === "userInput")).toEqual(
    [
      expect.objectContaining({
        text: text,
        sourceCommandId: commandId,
        turnId: runId,
        clientId: host.clientId,
      }),
    ],
  );
  const admitted = await task(fixture, host);
  assertTaskUnchanged(admitted, original, fixture, runId);
  expect(admitted.state.inputs).toEqual([
    expect.objectContaining({
      intent: expect.objectContaining({
        sourceCommandId: commandId,
        text: text,
      }),
    }),
  ]);
  const request = modelRequestSchema.parse(model.requests[0]?.body);
  expect(request.messages.filter((message) => message.role === "user")).toEqual(
    [expect.objectContaining({ content: text })],
  );
  const replay = await host.command("sendText", payload, commandId);
  expect(replay.status, JSON.stringify(replay.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(replay.body.result)).toEqual({
    ...ack,
    status: "duplicate",
  });
  expect((await snapshot(host)).meta).toEqual(running.meta);
  expect(model.requests).toHaveLength(1);
  return { original, running, runId };
}

async function completeUnicodeRun(
  fixture: Fixture,
  host: Host,
  model: Model,
  initial: Awaited<ReturnType<typeof observeUnicodeRun>>,
  text: string,
) {
  model.finish(0);
  const completed = await vi.waitFor(
    async () => {
      const value = await snapshot(host);
      expect(value.control).toMatchObject({
        phase: "completedSuccess",
        activeWorks: [],
        canStop: false,
      });
      expect(model.requests.map((entry) => entry.closed)).toEqual([true]);
      return value;
    },
    { timeout: 30_000 },
  ); // 原模型自然终态与连接清理期限。
  expect(completed.meta).toEqual(initial.running.meta);
  expect(
    completed.rows.window.filter((row) => row.kind === "turnHeader"),
  ).toEqual([
    expect.objectContaining({
      turnId: initial.runId,
      state: "completedSuccess",
    }),
  ]);
  expect(await runIds(fixture, host)).toEqual([initial.runId]);
  assertTaskUnchanged(
    await task(fixture, host),
    initial.original,
    fixture,
    null,
  );
  const native = await readNativePostMessages(fixture, host, initial.runId);
  expect(native.filter(HumanMessage.isInstance)).toEqual([
    expect.objectContaining({ content: text }),
  ]);
  expect(native.filter(AIMessage.isInstance)).toEqual([
    expect.objectContaining({ content: "正在运行 1" }),
  ]);
}

async function runTitleScenario(text: string, title: string) {
  const model = await heldModel();
  let fixture: Fixture | undefined;
  let host: Host | undefined;
  try {
    fixture = await createCodeUiHttpFixture();
    host = await createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
    });
    const initial = await observeUnicodeRun(fixture, host, model, text, title);
    await completeUnicodeRun(fixture, host, model, initial, text);
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
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code标题Unicode边界公共sendText integration",
  () => {
    it.each([
      { name: "实际app的24码点指令", text: INPUT_TEXT, title: INPUT_TEXT },
      {
        name: "emoji处截断长标题",
        text: "abcdefghijklmnopqrstuvw🚀尾部中文🙂保留在正文",
        title: "abcdefghijklmnopqrstuvw🚀",
      },
    ])(
      "$name可持久化并完成原Run，原正文/model/native完整且重放不重复",
      async ({ text, title }) => {
        await runTitleScenario(text, title);
      },
      90_000,
    ); // 独占真实HTTP/PG/模型SSE与native生命周期期限。
  },
);
