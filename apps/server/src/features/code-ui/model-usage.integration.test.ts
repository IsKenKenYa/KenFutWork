import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  zcodeUiProtocol as protocol,
  usageSummaryResponseSchema,
} from "@kenfutwork/shared";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { decodeNativeContextReference } from "../../agent/native-context-reference.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import {
  modelUsageFixture,
  USAGE_FINAL_TEXT,
  USAGE_READ_CALL,
  USAGE_READ_FILE,
  USAGE_READ_TEXT,
} from "./model-usage.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof modelUsageFixture>>;

async function snapshot(host: Host) {
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

async function summary(host: Host) {
  const response = await host.client.request("/api/usage/summary");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return usageSummaryResponseSchema.parse(response.body);
}

async function waitForCompletion(host: Host) {
  // 独占HTTP/数据库的测试同步期限，非Agent运行时限额。
  return vi.waitFor(
    async () => {
      const ended = await snapshot(host);
      expect(ended.control.phase, JSON.stringify(ended.control.lastError)).toBe(
        "completedSuccess",
      );
      expect(ended.control).toMatchObject({ canStop: false, activeWorks: [] });
      expect(ended.pendingInteractions).toEqual([]);
      expect(ended.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          text: USAGE_FINAL_TEXT,
          state: "complete",
        }),
      );
      const headers = ended.rows.window.filter(
        (row) => row.kind === "turnHeader",
      );
      expect(headers).toHaveLength(1);
      const header = headers[0];
      if (header?.kind !== "turnHeader") throw new Error("原Run缺少轮次身份。");
      expect(header.state).toBe("completedSuccess");
      return { ended, runId: header.turnId };
    },
    { timeout: 30_000 },
  );
}

function assertRealRead(model: Model) {
  expect(model.requests).toHaveLength(2);
  const [first, second] = model.requests;
  if (!first || !second) throw new Error("未观察到两次实际模型HTTP请求。");
  for (const request of [first, second]) {
    expect(request).toMatchObject({
      model: "stop-model",
      stream: true,
      stream_options: { include_usage: true },
    });
  }
  expect(first.tools?.map((tool) => tool.function.name)).toContain("Read");
  const call = second.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .find((entry) => entry.id === USAGE_READ_CALL);
  if (!call) throw new Error("后续模型请求缺少原Read调用。");
  expect(call.function.name).toBe("Read");
  expect(JSON.parse(call.function.arguments)).toEqual({
    file_path: USAGE_READ_FILE,
  });
  const results = second.messages.filter(
    (message) =>
      message.role === "tool" && message.tool_call_id === USAGE_READ_CALL,
  );
  expect(results).toHaveLength(1);
  expect(JSON.stringify(results[0]?.content)).toContain(USAGE_READ_TEXT);
}

async function assertNativeUsage(fixture: Fixture, host: Host, runId: string) {
  const boundaries = await fixture.app.kernel
    .get("agentRunMetadata")
    .getOwnedTurnBoundaries(fixture.actor, { taskId: host.sessionId, runId });
  const reference = boundaries.post?.context;
  if (reference?.status !== "captured" || !reference.reference)
    throw new Error("自然完成的原Run未持久化native post。");
  const native = decodeNativeContextReference(reference.reference);
  const persistence = await fixture.app.kernel
    .get("agentPersistence")
    .getPersistence();
  if (!persistence) throw new Error("原native上下文消费者未装配。");
  const checkpoint = await persistence.checkpointer.get({
    configurable: {
      thread_id: native.threadId,
      checkpoint_ns: native.namespace,
      checkpoint_id: native.checkpointId,
    },
  });
  const messages = checkpoint?.channel_values.messages;
  if (!Array.isArray(messages)) throw new Error("持久native消息缺失。");
  const ai = messages.filter(AIMessage.isInstance);
  const toolCall = ai.find((message) =>
    message.tool_calls?.some((call) => call.id === USAGE_READ_CALL),
  );
  if (!toolCall) throw new Error("native上下文丢失原Read调用。");
  // 同call的累计usage既出现在真实stream chunk，也保留在完整AIMessage结束结果。
  expect(toolCall.usage_metadata).toMatchObject({
    input_tokens: 10,
    output_tokens: 3,
  });
  const toolResult = messages
    .filter(ToolMessage.isInstance)
    .find((message) => message.tool_call_id === USAGE_READ_CALL);
  if (!toolResult) throw new Error("native上下文丢失原Read实际结果。");
  expect(JSON.stringify(toolResult.content)).toContain(USAGE_READ_TEXT);
  const final = ai.find((message) => message.content === USAGE_FINAL_TEXT);
  if (!final) throw new Error("native上下文缺少自然完成的正文。");
  expect(final.usage_metadata).toMatchObject({
    input_tokens: 10,
    output_tokens: 7,
  });
}

async function assertTaskUsage(fixture: Fixture, host: Host, runId: string) {
  // 先读实际migration/repository口径：usage按run_id归属，Task关联来自真实chat_session。
  // 不要求每次调用一行；按真实Task/Run求和同时支持调用账本和聚合落账。
  const record = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .queryOne<{
      input_tokens: string;
      output_tokens: string;
      total_tokens: string;
    }>(
      `select sum(u.input_tokens)::text as input_tokens,
              sum(u.output_tokens)::text as output_tokens,
              sum(u.total_tokens)::text as total_tokens
       from public.usage_records u
       join public.agent_runs r on r.id::text=u.run_id
       join public.code_ui_sessions t on t.chat_session_id=r.session_id
       where u.instance_id=:instance and t.instance_id=:instance
         and t.id=$1 and r.id=$2`,
      [host.sessionId, runId],
    );
  expect(Number(record?.input_tokens)).toBe(20);
  expect(Number(record?.output_tokens)).toBe(10);
  expect(Number(record?.total_tokens)).toBe(30);
}

/** 公开HTTP/真实Task/Harness/PG；仅替换外部OpenAI-compatible模型网络边界。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code实际两次模型调用用量 integration",
  () => {
    it("Read调用与正文调用输入token相同仍分别计量，同call stream/end累计上报不重复入账", async () => {
      const model = await modelUsageFixture();
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      try {
        fixture = await createCodeUiHttpFixture();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        expect((await summary(host)).totals).toMatchObject({
          inputTokens: 0,
          outputTokens: 0,
        });
        await writeFile(
          join(host.workspacePath, USAGE_READ_FILE),
          USAGE_READ_TEXT,
        );
        const commandId = randomUUID();
        const sent = await host.command(
          "sendText",
          {
            text: "先实际Read usage-read.txt，然后返回完成正文。",
            mode: "build",
            planEnabled: false,
          },
          commandId,
        );
        expect(sent.status, JSON.stringify(sent.body)).toBe(200);
        expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
          "accepted",
        );
        const { ended, runId } = await waitForCompletion(host);
        assertRealRead(model);
        expect(ended.rows.window).toContainEqual(
          expect.objectContaining({
            kind: "userInput",
            sourceCommandId: commandId,
            turnId: runId,
          }),
        );
        await assertNativeUsage(fixture, host, runId);
        const current = host;
        await vi.waitFor(
          async () => {
            const usage = await summary(current);
            expect(usage.totals).toMatchObject({
              inputTokens: 20,
              outputTokens: 10,
            });
            expect(usage.byModel).toHaveLength(1);
            expect(usage.byModel[0]).toMatchObject({
              model: "stop-model",
              capability: "chat",
              inputTokens: 20,
              outputTokens: 10,
            });
          },
          { timeout: 30_000 },
        );
        await assertTaskUsage(fixture, host, runId);
        expect((await snapshot(host)).usage.cumulative).toMatchObject({
          inputTokens: 20,
          outputTokens: 10,
        });
        expect(model.requests).toHaveLength(2);
      } finally {
        try {
          if (host && (await snapshot(host)).control.activeWorks.length)
            await host.command("stop", {});
        } finally {
          await model.close();
          await host?.dispose();
          await fixture?.close();
        }
      }
    }, 90_000); // 独占HTTP、数据库与模型网络的测试期限，非运行时治理值。
  },
);
