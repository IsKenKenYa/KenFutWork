import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { modelSelectionSchema } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createChatRepository } from "../chat/repository.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { createCodeUiRepository } from "./repository.js";

const A_FILE = "retry-a.txt";
const A_READ = "A_NATIVE_READ_SENTINEL";
const A_ANSWER = "A_COMPLETE_ANSWER";
const B_INPUT = "B_CANONICAL_ORIGINAL_INPUT";
const B_ATTACHMENT = "B_ORIGINAL_ATTACHMENT_SENTINEL";
const B_ANSWER = "B_OLD_ANSWER_MUST_NOT_ENTER_RETRY";
const RETRY_ANSWER = "B_RETRY_COMPLETE_ANSWER";
const READ_CALL = "retry-a-real-read";
const MODEL_B = "retry-model-b";

const modelMessageSchema = z
  .object({
    role: z.string(),
    content: z.unknown().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string(),
          type: z.string(),
          function: z.object({ name: z.string(), arguments: z.string() }),
        }),
      )
      .optional(),
  })
  .passthrough();
const modelRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(modelMessageSchema),
    reasoning_effort: z.string().optional(),
  })
  .passthrough();
type ModelRequest = z.infer<typeof modelRequestSchema>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type HttpFixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;

function requestAt(requests: readonly ModelRequest[], index: number) {
  const request = requests[index];
  if (!request) throw new Error(`未观察到第${index + 1}次实际模型请求`);
  return request;
}

function messageText(message: ModelRequest["messages"][number]): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function completeResponse(
  response: ServerResponse,
  body: ModelRequest,
  index: number,
) {
  const write = (delta: unknown, finishReason: string | null) =>
    response.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-retry-${index}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (index === 0) {
    write(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: READ_CALL,
            type: "function",
            function: {
              name: "Read",
              arguments: JSON.stringify({ file_path: A_FILE }),
            },
          },
        ],
      },
      null,
    );
    write({}, "tool_calls");
  } else {
    const text = [A_ANSWER, B_ANSWER, RETRY_ANSWER][index - 1];
    if (!text) throw new Error("有限模型脚本收到额外调用");
    write({ role: "assistant", content: text }, null);
    write({}, "stop");
  }
  response.end("data: [DONE]\n\n");
}

/** 外部LLM边界：四次有限SSE响应，Read结果仍由真实工具执行器产生。 */
async function finiteHistoryModel() {
  const requests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        !request.url?.endsWith("/chat/completions")
      ) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = modelRequestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const index = requests.length;
      requests.push(body);
      if (index >= 4) {
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "有限模型脚本调用次数已耗尽" },
          }),
        );
        return;
      }
      completeResponse(response, body, index);
    } catch (error) {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function waitCompleted(host: Host, text: string) {
  // 仅测试同步期限；不能用stop把interrupted行冒充原retry契约要求的complete。
  await vi.waitFor(
    async () => {
      const snapshot = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(
        snapshot.control.phase,
        JSON.stringify({
          expectedReply: text,
          error: snapshot.control.lastError,
          rows: snapshot.rows.window.filter(
            (row) => row.kind === "timelineMarker",
          ),
        }),
      ).toBe("completedSuccess");
      expect(
        snapshot.rows.window.filter((row) => row.kind === "assistantText"),
      ).toContainEqual(expect.objectContaining({ text, state: "complete" }));
    },
    { timeout: 30_000 },
  );
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

async function prepareModelB(host: Host) {
  const initial = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  const providerId = initial.config.modelSelection?.providerId;
  if (!providerId) throw new Error("原session夹具未提供实际模型供应商");
  const result = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method: "addPersonalModel",
    args: [
      providerId,
      MODEL_B,
      {
        optionSpecs: {
          reasoningLevel: {
            values: ["low", "high"],
            map: '{"reasoning_effort": reasoningLevel}',
          },
        },
      },
    ],
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return modelSelectionSchema.parse({
    providerId,
    modelId: MODEL_B,
    options: { reasoningLevel: "low" },
  });
}

async function uploadBInput(host: Host): Promise<protocol.AttachmentRef> {
  const bytes = Buffer.from(B_ATTACHMENT);
  const uploadId = randomUUID();
  const identity = { sessionId: host.sessionId, uploadId };
  const begun = await host.stream.rpc("attachmentBeginV4", [
    {
      ...identity,
      fileName: "original-b.txt",
      mime: "text/plain",
      totalBytes: bytes.length,
      totalChunks: 1,
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    },
  ]);
  expect(begun.status, JSON.stringify(begun.body)).toBe(200);
  expect(begun.body.result.state).toBe("staging");
  const chunked = await host.stream.rpc("attachmentChunkV4", [
    {
      ...identity,
      chunkIndex: 0,
      dataBase64: bytes.toString("base64"),
    },
  ]);
  expect(chunked.status, JSON.stringify(chunked.body)).toBe(200);
  const committed = await host.stream.rpc("attachmentCommitV4", [identity]);
  expect(committed.status, JSON.stringify(committed.body)).toBe(200);
  const result = protocol.v4AttachmentPutResultSchema.parse(
    committed.body.result,
  );
  return {
    ref: result.ref,
    fileName: "original-b.txt",
    mime: "text/plain",
    bytes: bytes.length,
  };
}

async function taskFacts(fixture: HttpFixture, host: Host) {
  // 夹具身份来自已创建的真实Task行；不构造LocalActor或legacy账户进行越权读取。
  const identity = await fixture.database.persistence.queryOne<{
    instance_id: string;
  }>("select instance_id from public.code_ui_sessions where id=$1", [
    host.sessionId,
  ]);
  if (!identity) throw new Error("原HTTP Task身份未持久化");
  const task = await createCodeUiRepository(fixture.database.persistence).find(
    identity.instance_id,
    host.sessionId,
  );
  const binding = await createChatRepository(
    fixture.database.persistence,
  ).findSessionThread(identity.instance_id, host.sessionId);
  if (!task?.state || !binding?.thread_id)
    throw new Error("原Task/上下文绑定不可读取");
  return { task, state: task.state, binding };
}

function assertNativeRead(messages: ModelRequest["messages"]) {
  const call = messages
    .flatMap((message) => message.tool_calls ?? [])
    .find((entry) => entry.id === READ_CALL);
  expect(call).toMatchObject({ type: "function", function: { name: "Read" } });
  const result = messages.find(
    (message) => message.role === "tool" && message.tool_call_id === READ_CALL,
  );
  if (!result) throw new Error("实际Read的原生关联结果缺失");
  expect(messageText(result)).toContain(A_READ);
}

type FiniteModel = Awaited<ReturnType<typeof finiteHistoryModel>>;

async function prepareCompletedAB(
  fixture: HttpFixture,
  host: Host,
  model: FiniteModel,
) {
  const modelB = await prepareModelB(host);
  await writeFile(join(host.workspacePath, A_FILE), A_READ);
  const a = await host.command("sendText", {
    text: "A_READ_REQUEST",
    mode: "build",
    planEnabled: false,
  });
  expect(a.body.result.status).toBe("accepted");
  await waitCompleted(host, A_ANSWER);
  expect(model.requests).toHaveLength(2);
  assertNativeRead(requestAt(model.requests, 1).messages);

  const attachment = await uploadBInput(host);
  const bCommandId = randomUUID();
  const b = await host.command(
    "sendText",
    {
      text: B_INPUT,
      attachments: [attachment],
      modelSelection: modelB,
      mode: "build",
      planEnabled: false,
    },
    bCommandId,
  );
  expect(b.body.result.status).toBe("accepted");
  const completed = await waitCompleted(host, B_ANSWER);
  const target = completed.rows.window
    .filter((row) => row.kind === "assistantText")
    .at(-1);
  if (target?.kind !== "assistantText" || target.state !== "complete")
    throw new Error("B缺少原retry契约要求的最新complete assistant");
  expect(target.actions?.canRetry).toBe(true);
  expect(
    completed.rows.window
      .filter((row) => row.kind === "assistantText")
      .slice(0, -1)
      .some((row) => row.actions?.canRetry),
  ).toBe(false);
  const original = await taskFacts(fixture, host);
  const admitted = original.state.inputs?.find(
    (input) => input.runId === target.turnId,
  );
  if (!admitted) throw new Error("B的canonical admission未持久化");
  expect(admitted.intent).toMatchObject({
    sourceCommandId: bCommandId,
    clientId: host.clientId,
    kind: "sendText",
    text: B_INPUT,
    attachments: [attachment],
    modelSelection: modelB,
    mode: "build",
    planEnabled: false,
  });
  expect(admitted.modelInvocation).toMatchObject({
    modelId: MODEL_B,
    body: { reasoning_effort: "low" },
  });
  const originalRequest = requestAt(model.requests, 2);
  expect(originalRequest).toMatchObject({
    model: MODEL_B,
    reasoning_effort: "low",
  });
  expect(originalRequest.messages.map(messageText).join("\n")).toContain(
    B_ATTACHMENT,
  );
  return {
    modelB,
    attachment,
    bCommandId,
    completed,
    target,
    original,
    admitted,
  };
}

type CompletedAB = Awaited<ReturnType<typeof prepareCompletedAB>>;

async function changeCurrentMode(host: Host, prepared: CompletedAB) {
  // 原模型选择器只修改composer draft。本切片使用已接通的原模式命令作冻结对照，
  // 不宣称后台模型已切C；draft模型C→retry的UI验收由后续实际组件/浏览器完成。
  const changed = await host.command(
    "switchCollaborationMode",
    { mode: "yolo" },
    randomUUID(),
    {
      baseRevision: prepared.completed.revision,
      baseLogEpoch: prepared.completed.logEpoch,
    },
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body.result.status).toBe("accepted");
  const current = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  expect(current.config.modelSelection).toEqual(prepared.modelB);
  expect(current.config.mode).toBe("yolo");
  expect(current.config.planEnabled ?? false).toBe(false);
  return current;
}

async function assertRetriedState(
  fixture: HttpFixture,
  host: Host,
  model: FiniteModel,
  prepared: CompletedAB,
  retryId: string,
) {
  const ended = await waitCompleted(host, RETRY_ANSWER);
  expect(model.requests).toHaveLength(4);
  const retryRequest = requestAt(model.requests, 3);
  expect(retryRequest).toMatchObject({
    model: MODEL_B,
    reasoning_effort: "low",
  });
  assertNativeRead(retryRequest.messages);
  expect(
    retryRequest.messages.filter(
      (message) =>
        message.role === "user" && messageText(message).includes(B_INPUT),
    ),
  ).toHaveLength(1);
  const context = retryRequest.messages.map(messageText).join("\n");
  expect(context).toContain(B_ATTACHMENT);
  expect(context).not.toContain(B_ANSWER);
  const rebound = await taskFacts(fixture, host);
  expect(rebound.task.id).toBe(host.sessionId);
  expect(rebound.task.sandbox_mode).toBe("workspace-write");
  expect(rebound.binding.thread_id).not.toBe(
    prepared.original.binding.thread_id,
  );
  const replay = rebound.state.inputs?.find(
    (input) => input.intent.sourceCommandId === retryId,
  );
  if (!replay) throw new Error("retry canonical输入未持久化");
  expect(replay.intent).toMatchObject({
    kind: prepared.admitted.intent.kind,
    text: B_INPUT,
    attachments: [prepared.attachment],
    modelSelection: prepared.modelB,
    mode: "build",
    planEnabled: false,
  });
  expect(replay.modelInvocation).toEqual(prepared.admitted.modelInvocation);
  expect(
    ended.rows.window.filter(
      (row) => row.kind === "userInput" && row.sourceCommandId === retryId,
    ),
  ).toMatchObject([
    {
      origin: "realUser",
      rootSourceCommandId: prepared.bCommandId,
      attachments: [prepared.attachment],
    },
  ]);
  expect(
    await readFile(join(host.workspacePath, "preserve-current.txt"), "utf8"),
  ).toBe("CURRENT_FILES_MUST_SURVIVE");
}

async function runHistoryRetryTracer() {
  const fixture = await createCodeUiHttpFixture();
  const model = await finiteHistoryModel();
  let host: Host | undefined;
  try {
    host = await createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
    });
    const prepared = await prepareCompletedAB(fixture, host, model);
    const beforeRetry = await changeCurrentMode(host, prepared);
    await writeFile(
      join(host.workspacePath, "preserve-current.txt"),
      "CURRENT_FILES_MUST_SURVIVE",
    );
    const retryId = randomUUID();
    const guard = {
      baseRevision: beforeRetry.revision,
      baseLogEpoch: beforeRetry.logEpoch,
    };
    const payload = {
      target: {
        rowId: prepared.target.rowId,
        entityId: prepared.target.entityId,
      },
    };
    const retried = await host.command("retryTurn", payload, retryId, guard);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.result.status).toBe("accepted");
    await assertRetriedState(fixture, host, model, prepared, retryId);
    const repeated = await host.command("retryTurn", payload, retryId, guard);
    expect(repeated.body.result.status).toBe("duplicate");
    expect(model.requests).toHaveLength(4);
  } finally {
    if (host) {
      const snapshot = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      if (snapshot.control.canStop) await host.command("stop", {});
      await host.dispose();
    }
    await model.close();
    await fixture.close();
  }
}

/** Actor/HTTP夹具迁移就绪后才运行；未运行与默认skipped均不算产品RED或GREEN。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原retryTurn最新assistant真实宿主 integration",
  () => {
    it("真实turn-end仍在执行时完成态不可发布，收尾后公开完成才允许下一轮自然执行", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await finiteHistoryModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await writeFile(join(host.workspacePath, A_FILE), A_READ);
        await writeFile(
          join(host.workspacePath, "finish.cjs"),
          [
            'const fs=require("node:fs");',
            'fs.writeFileSync("finish.entered","ready");',
            // 仅真实验收进程的文件握手节拍，不是Agent运行时数值。
            'const timer=setInterval(()=>{if(fs.existsSync("finish.release")){clearInterval(timer);process.exitCode=0;}},10);',
          ].join("\n"),
        );
        const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
        const initial = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        const selection = initial.config.modelSelection;
        if (!selection) throw new Error("真实钩子验收缺少已配置模型");
        const settings = await host.client.request(
          "/api/instance/settings",
          {
            defaultModel: `${selection.providerId}:${selection.modelId}`,
            hooks: [{ event: "turn-end", command: `${executable} finish.cjs` }],
            executeTimeoutMs: 180_000,
          },
          "PATCH",
        );
        expect(settings.status, JSON.stringify(settings.body)).toBe(200);
        const sent = await host.command("sendText", { text: "A_READ_REQUEST" });
        expect(sent.body.result.status).toBe("accepted");
        await vi.waitFor(
          async () =>
            expect(
              await readFile(
                join(host!.workspacePath, "finish.entered"),
                "utf8",
              ),
            ).toBe("ready"),
          { timeout: 30_000 },
        );
        const closing = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(
          closing.control.phase,
          JSON.stringify(closing.control.lastError),
        ).toBe("running");
        expect(model.requests).toHaveLength(2);
        const disabled = await host.client.request(
          "/api/instance/settings",
          { hooks: [] },
          "PATCH",
        );
        expect(disabled.status).toBe(200);
        await writeFile(join(host.workspacePath, "finish.release"), "release");
        await waitCompleted(host, A_ANSWER);
        const next = await host.command("sendText", { text: B_INPUT });
        expect(next.body.result.status).toBe("accepted");
        await waitCompleted(host, B_ANSWER);
        expect(model.requests).toHaveLength(3);
        assertNativeRead(requestAt(model.requests, 2).messages);
      } finally {
        if (host)
          await writeFile(
            join(host.workspacePath, "finish.release"),
            "cleanup",
          );
        try {
          if (host) await host.command("stop", {});
        } finally {
          await model.close();
          await host?.dispose();
          await fixture.close();
        }
      }
    }, 180_000); // 独占HTTP/PG和真实钩子的测试期限。
    it("公开A自然完成后立即发送B，真实Read历史与附件保留且B自然完成，不撞上一轮前台占用", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await finiteHistoryModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await prepareCompletedAB(fixture, host, model);
        expect(model.requests).toHaveLength(3);
        expect(requestAt(model.requests, 2).model).toBe(MODEL_B);
      } finally {
        try {
          if (host) await host.command("stop", {});
        } finally {
          await model.close();
          await host?.dispose();
          await fixture.close();
        }
      }
    }, 180_000); // 真实HTTP/PG的验收期限，非运行时治理值。
    it(
      "A真实Read与B自然complete后，原retry保留B冻结配置/附件lineage与当前文件，重放只执行一次",
      runHistoryRetryTracer,
      120_000,
    );
    it("ready发布真实失败不留下已切换的半分支，回执可重放且用户可恢复后重试", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await finiteHistoryModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const prepared = await prepareCompletedAB(fixture, host, model);
        const original = await changeCurrentMode(host, prepared);
        const originalFacts = await taskFacts(fixture, host);
        // 只注入独占临时PG的外部提交故障，不修改运行服务或现存数据库。
        await fixture.database.persistence.execute(
          `create function public.reject_test_history_ready() returns trigger language plpgsql as $$ begin if old.execution_state='revoking' and new.execution_state='ready' then raise exception '测试历史ready写失败'; end if; return new; end $$`,
        );
        await fixture.database.persistence.execute(
          "create trigger reject_test_history_ready before update on public.code_ui_sessions for each row execute function public.reject_test_history_ready()",
        );
        const retryId = randomUUID();
        const payload = {
          target: {
            rowId: prepared.target.rowId,
            entityId: prepared.target.entityId,
          },
        };
        const guard = {
          baseRevision: original.revision,
          baseLogEpoch: original.logEpoch,
        };
        const failed = await host.command("retryTurn", payload, retryId, guard);
        const current = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(current.logEpoch).toBe(original.logEpoch);
        const facts = await taskFacts(fixture, host);
        expect(facts.binding.thread_id).toBe(originalFacts.binding.thread_id);
        expect(facts.task.sandbox_mode).toBe("danger-full-access");
        expect(facts.task.execution_state).toBe("failed");
        expect(current.control.phase).toBe("completedSuccess");
        expect(model.requests).toHaveLength(3);
        expect(failed.status, JSON.stringify(failed.body)).toBe(200);
        expect(failed.body.result).toMatchObject({
          status: "failed",
          message: "测试历史ready写失败",
        });
        await fixture.database.persistence.execute(
          "drop trigger reject_test_history_ready on public.code_ui_sessions",
        );
        const replayed = await host.command(
          "retryTurn",
          payload,
          retryId,
          guard,
        );
        expect(replayed.body.result).toMatchObject({
          status: "duplicate",
          message: "测试历史ready写失败",
        });
        expect(model.requests).toHaveLength(3);
        const recovered = await host.command(
          "switchCollaborationMode",
          { mode: "build" },
          randomUUID(),
          { baseRevision: current.revision, baseLogEpoch: current.logEpoch },
        );
        expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
        expect(
          recovered.body.result.status,
          JSON.stringify(recovered.body),
        ).toBe("accepted");
        const ready = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        const retried = await host.command("retryTurn", payload, randomUUID(), {
          baseRevision: ready.revision,
          baseLogEpoch: ready.logEpoch,
        });
        expect(retried.body.result.status).toBe("accepted");
        await waitCompleted(host, RETRY_ANSWER);
        expect(model.requests).toHaveLength(4);
      } finally {
        try {
          if (host) await host.dispose();
        } finally {
          await model.close();
          await fixture.close();
        }
      }
    }, 120_000); // 真实HTTP/PG的故障与恢复验收期限。
  },
);
