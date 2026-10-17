import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
const REVIEW_MODEL = "approval-review-test";
const WRITE_CALL = "review-write";
const FILE = "reviewed.txt";
const CONTENT = "reviewed by an independent model\n";
const REQUEST = `创建 ${FILE}，内容为 ${JSON.stringify(CONTENT)}。`;

/** 仅替换独立审查模型的HTTP边界，兼容原生SDK实际选择的流式与非流式请求。 */
async function reviewerModel(hold = false) {
  const requests: Array<{
    body: Record<string, unknown>;
    response: ServerResponse;
    closed: boolean;
  }> = [];
  const allow = (index: number) => {
    const entry = requests[index];
    if (!entry) throw new Error("独立审查模型尚未收到请求。");
    const response = entry.response;
    if (response.destroyed || response.writableEnded) return;
    const id = `chatcmpl-review-${index + 1}`;
    const usage = { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 };
    if (entry.body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const part of [
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: '{"decision":"allow"}' },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage },
      ])
        response.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: REVIEW_MODEL,
            ...part,
          })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created: 1,
        model: REVIEW_MODEL,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"decision":"allow"}' },
            finish_reason: "stop",
          },
        ],
        usage,
      }),
    );
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    const entry = { body, response, closed: false };
    requests.push(entry);
    response.once("close", () => {
      entry.closed = true;
    });
    if (!hold) allow(requests.length - 1);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("独立审查模型未取得本机端口。");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    allow,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function setup(hold = false) {
  const model = await heldModel({
    initialTool: {
      id: WRITE_CALL,
      name: "Write",
      arguments: { file_path: FILE, content: CONTENT },
    },
    usage: { promptTokens: 11, completionTokens: 3 },
  });
  const reviewer = await reviewerModel(hold);
  let fixture: Fixture | undefined;
  let host: Host | undefined;
  const close = async () => {
    const current = fixture;
    const session = host;
    const failures: unknown[] = [];
    for (const dispose of [
      async () => {
        if (
          current &&
          session &&
          (await snapshot(current, session.sessionId)).control.activeWorks
            .length
        )
          await session.command("stop", {});
      },
      () => session?.dispose(),
      () => model.close(),
      () => reviewer.close(),
      () => current?.close(),
    ]) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "独立审批集成资源未全部关闭。");
  };
  try {
    fixture = await createCodeUiHttpFixture();
    host = await createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
      initialConfig: { mode: "build", planEnabled: false },
    });
    const provider = await fixture.app.kernel
      .get("modelProviders")
      .createInstance(fixture.actor, {
        name: "独立审批集成模型",
        protocol: "openai-compatible",
        baseUrl: reviewer.baseUrl,
        apiKey: "approval-integration-only-not-a-key",
        enabled: true,
        models: [
          {
            id: REVIEW_MODEL,
            name: "独立审批",
            capability: "chat",
            enabled: true,
            contextWindow: 65_536,
            maxOutputTokens: 512,
            vision: false,
            inputModalities: ["text"],
          },
        ],
        compat: {
          chatApi: "completions",
          codeUi: {
            models: {
              [REVIEW_MODEL]: {
                useRecommendedConfig: true,
                config: {
                  optionSpecs: {
                    reasoningLevel: { values: ["default"], map: "{}" },
                    maxOutputTokens: {
                      max: 512,
                      map: '{"max_tokens": maxOutputTokens}',
                    },
                  },
                },
              },
            },
          },
        },
      });
    const defaults = {
      chat: null,
      approval: { providerId: provider.id, modelId: REVIEW_MODEL },
      image: { mode: "auto" },
      video: { mode: "auto" },
    };
    const saved = await host.client.request("/api/code-ui/rpc", {
      service: "providerSettingsService",
      method: "saveModelDefaults",
      args: [defaults],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.result).toEqual(defaults);
    return { fixture, host, model, reviewer, provider, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function approvalEvents(fixture: Fixture, host: Host) {
  return fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{
      payload: {
        type: string;
        decision?: string;
        identity: { runId: string; toolCallId: string };
        interaction: { interactionId: string };
      };
    }>(
      `select payload from public.code_ui_events
     where instance_id=:instance and root_session_id=$1 and event_key like 'approval:%'
       and payload->'identity'->>'toolCallId'=$2 order by seq`,
      [host.sessionId, WRITE_CALL],
    );
}

/** 真实临时PG、HTTP、SSE与native SDK；主模型和独立审查均只访问本机测试端点。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "独立模型审批公开宿主 integration",
  () => {
    it("build单次输入经独立模型批准真实Write，原审批顺序持久化且独立用量归原Run", async () => {
      const f = await setup();
      try {
        const before = await snapshot(f.fixture, f.host.sessionId);
        const primaryProviderId = before.config.modelSelection?.providerId;
        if (!primaryProviderId) throw new Error("主模型缺少真实供应商身份。");
        expect(primaryProviderId).not.toBe(f.provider.id);
        const sent = await f.host.command("sendText", {
          text: REQUEST,
          mode: "build",
          planEnabled: false,
        });
        expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
          "accepted",
        );
        await vi.waitFor(
          async () => {
            expect(
              await readFile(join(f.host.workspacePath, FILE), "utf8"),
            ).toBe(CONTENT);
            expect(f.model.requests).toHaveLength(2);
          },
          { timeout: 30_000 },
        );
        expect(f.reviewer.requests).toHaveLength(1);
        const request = f.reviewer.requests[0]!.body;
        expect(request.model).toBe(REVIEW_MODEL);
        expect(request.tools).toBeUndefined();
        expect(request.tool_choice).toBeUndefined();
        expect(JSON.stringify(request.messages)).toContain(FILE);
        expect(JSON.stringify(request.messages)).not.toContain(
          "approval-integration-only-not-a-key",
        );
        const events = await approvalEvents(f.fixture, f.host);
        expect(events.map(({ payload }) => payload.type)).toEqual([
          "requested",
          "resolved",
        ]);
        expect(events[1]?.payload.decision).toBe("allow");
        expect(events[1]?.payload.interaction.interactionId).toBe(
          events[0]?.payload.interaction.interactionId,
        );
        const running = await snapshot(f.fixture, f.host.sessionId);
        expect(running.pendingInteractions).toEqual([]);
        expect(
          f.fixture.app.kernel
            .get("permissions")
            .listPending(f.fixture.actor.instanceId, f.host.sessionId),
        ).toEqual([]);
        f.model.finish(1);
        const ended = await waitPhase(
          f.fixture,
          f.host.sessionId,
          "completedSuccess",
        );
        expect(ended.pendingInteractions).toEqual([]);
        expect(ended.rows.window).toContainEqual(
          expect.objectContaining({
            kind: "toolCall",
            toolName: "Write",
            status: "success",
          }),
        );
        const header = ended.rows.window.find(
          (row) => row.kind === "turnHeader",
        );
        if (header?.kind !== "turnHeader")
          throw new Error("审批所在轮次缺少真实Run身份。");
        expect(events[0]?.payload.identity.runId).toBe(header.turnId);
        await vi.waitFor(
          async () => {
            const rows = await f.fixture.database.persistence
              .forInstance(f.fixture.actor.instanceId)
              .query<{
                provider: string;
                provider_instance_id: string;
                model: string;
                input_tokens: string;
                output_tokens: string;
              }>(
                `select provider,provider_instance_id,model,
                        sum(input_tokens)::text as input_tokens,
                        sum(output_tokens)::text as output_tokens
                 from public.usage_records where instance_id=:instance and run_id=$1
                 group by provider,provider_instance_id,model`,
                [header.turnId],
              );
            expect(rows).toHaveLength(2);
            expect(rows).toContainEqual({
              provider: "instance",
              provider_instance_id: f.provider.id,
              model: REVIEW_MODEL,
              input_tokens: "17",
              output_tokens: "4",
            });
            expect(rows).toContainEqual({
              provider: "instance",
              provider_instance_id: primaryProviderId,
              model: "stop-model",
              input_tokens: "22",
              output_tokens: "6",
            });
          },
          { timeout: 30_000 },
        );
        expect(f.model.requests).toHaveLength(2);
        expect(f.reviewer.requests).toHaveLength(1);
      } finally {
        await f.close();
      }
    }, 120_000);

    it("审查等待中修改供应商会取消旧请求并保留原人工审批，迟到allow不能写文件", async () => {
      const f = await setup(true);
      try {
        await f.host.command("sendText", {
          text: REQUEST,
          mode: "build",
          planEnabled: false,
        });
        await vi.waitFor(() => expect(f.reviewer.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        const waiting = await snapshot(f.fixture, f.host.sessionId);
        const pending = waiting.pendingInteractions.find(
          (entry) => entry.kind === "permission",
        );
        if (!pending) throw new Error("独立审查缺少原人工审批请求。");
        await expect(
          readFile(join(f.host.workspacePath, FILE)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await f.fixture.app.kernel
          .get("modelProviders")
          .updateInstance(f.fixture.actor, f.provider.id, {
            enabled: false,
            expectedRevision: f.provider.configRevision,
          });
        await vi.waitFor(
          () => expect(f.reviewer.requests[0]?.closed).toBe(true),
          {
            timeout: 30_000,
          },
        );
        f.reviewer.allow(0);
        const current = await snapshot(f.fixture, f.host.sessionId);
        expect(
          current.pendingInteractions.map((entry) => entry.interactionId),
        ).toEqual([pending.interactionId]);
        expect(current.rows.window).toContainEqual(
          expect.objectContaining({
            kind: "toolCall",
            toolName: "Write",
            status: "pendingApproval",
          }),
        );
        expect(
          (await approvalEvents(f.fixture, f.host)).map(
            ({ payload }) => payload.type,
          ),
        ).toEqual(["requested"]);
        await expect(
          readFile(join(f.host.workspacePath, FILE)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const execution = current.control.activeWorks.find(
          (work) => work.kind === "primaryTurn",
        )?.foregroundExecutionId;
        if (!execution) throw new Error("审批等待中的原Run身份缺失。");
        const stopped = await f.host.command("stop", {
          expectedForegroundExecutionId: execution,
        });
        expect(stopped.body.result.status).toBe("accepted");
        expect(
          (await waitPhase(f.fixture, f.host.sessionId, "completedInterrupted"))
            .pendingInteractions,
        ).toEqual([]);
        await expect(
          readFile(join(f.host.workspacePath, FILE)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(f.model.requests).toHaveLength(1);
        expect(f.reviewer.requests).toHaveLength(1);
      } finally {
        await f.close();
      }
    }, 120_000);
  },
);
