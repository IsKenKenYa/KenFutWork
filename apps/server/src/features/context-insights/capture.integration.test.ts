import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { describe, expect, it, vi } from "vitest";
import { createLlmRequestRetryMiddleware } from "../../agent/llm-retry-middleware.js";
import { createModelObservationMiddleware } from "../../agent/model-observation.js";
import { createModelRequestPort } from "../../agent/model-request.js";
import { createInstanceChatModel } from "../../providers/openai-compatible/index.js";
import { heldModel } from "../code-ui/model-stream.fixture.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createContextRequestCallbacks } from "./capture.js";
import { createContextInspectionService } from "./service.js";

async function captureFixture(httpStatus?: number) {
  const database = await createTaskWorkDatabase();
  const provider = await heldModel({
    ...(httpStatus ? { rejectStatus: httpStatus } : {}),
  });
  let providerClosed = false;
  const closeProvider = async () => {
    if (providerClosed) return;
    providerClosed = true;
    await provider.close();
  };
  const service = createContextInspectionService({
    persistence: database.persistence,
    localInstance: database.localInstance,
    readPageCharacters: async () => 128,
  });
  const owner = {
    instanceId: database.instanceId,
    taskId: database.context.scope.taskId,
    runId: randomUUID(),
  };
  const model = createInstanceChatModel("capture-model", {
    apiKey: "fixture-key",
    baseUrl: provider.baseUrl,
    useResponsesApi: false,
    invocationMaxRetries: 0,
  });
  const controller = new AbortController();
  let usageCount = 0;
  const port = createModelRequestPort({
    signal: controller.signal,
    resolve: async () => ({
      model,
      owner: { provider: "instance", model: "capture-model" },
      effectiveOutputTokens: 100,
      inputTokenLimit: null,
    }),
    onUsage: async () => {
      usageCount++;
    },
    createModelCallbacks: (purpose) => [
      createContextRequestCallbacks(service.writer, owner, purpose),
    ],
  });
  return {
    port,
    model,
    callbacks: [createContextRequestCallbacks(service.writer, owner)],
    provider,
    controller,
    closeProvider,
    request: {
      purpose: "goal-evaluation" as const,
      invocation: {
        providerId: randomUUID(),
        modelId: "capture-model",
        configRevision: 1,
        useResponsesApi: false,
        body: {},
        inputCapabilities: { image: false, pdf: false },
      },
      system: "评估规则",
      input: "任务证据",
      remainingTokens: null,
    },
    async summaries() {
      return (await service.list(database.actor, { taskId: owner.taskId }))
        .requests;
    },
    async read(part: "input" | "output") {
      const request = (
        await service.list(database.actor, { taskId: owner.taskId })
      ).requests[0];
      if (!request) throw new Error("请求记录尚未保存");
      const chunks: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await service.read(database.actor, {
          taskId: owner.taskId,
          requestId: request.id,
          part,
          offset,
        });
        chunks.push(page.text);
        offset = page.nextOffset;
      }
      return JSON.parse(chunks.join(""));
    },
    usageCount: () => usageCount,
    async close() {
      controller.abort();
      await closeProvider();
      await database.close();
    },
  };
}

describe.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "真实模型流的上下文终态",
  () => {
    it.each([429, 503])(
      "外层重试分别保存 HTTP %s 的独立失败请求",
      async (status) => {
        const f = await captureFixture(status);
        try {
          const retry = createLlmRequestRetryMiddleware({
            maxAttempts: 3,
            infinite: false,
            signal: f.controller.signal,
            delayMs: () => Promise.resolve(),
          });
          const agent = createAgent({
            model: f.model,
            tools: [],
            middleware: [
              retry,
              ...createModelObservationMiddleware(
                [
                  {
                    preset: "code",
                    createMiddleware: () => retry,
                    createModelCallbacks: () => f.callbacks,
                  },
                ],
                {},
              ),
            ],
          });
          await expect(
            agent.invoke({ messages: [new HumanMessage("检查外层重试记录")] }),
          ).rejects.toThrow();
          expect(f.provider.requests).toHaveLength(3);
          const saved = await f.summaries();
          expect(saved).toHaveLength(3);
          expect(new Set(saved.map((request) => request.id)).size).toBe(3);
          expect(saved).toEqual(
            Array.from({ length: 3 }, () =>
              expect.objectContaining({
                status: "failed",
                httpStatus: status,
                purpose: "agent",
                usage: null,
              }),
            ),
          );
          expect(f.usageCount()).toBe(0);
        } finally {
          await f.close();
        }
      },
    );

    it("请求输入保存原生工具状态但不保存宿主数据", async () => {
      const f = await captureFixture();
      try {
        const pending = f.model.invoke(
          [
            new HumanMessage("生成图片"),
            new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "image-1",
                  name: "generate_image",
                  args: { prompt: "海报" },
                },
              ],
            }),
            new ToolMessage({
              status: "error",
              tool_call_id: "image-1",
              content: "生成结果保存失败",
              artifact: { internalPath: "private-output-path" },
            }),
          ],
          { callbacks: f.callbacks, signal: f.controller.signal },
        );
        await Promise.race([f.provider.firstRequest, pending]);
        f.provider.finish(0);
        await pending;
        expect(f.provider.requests[0]?.body.messages).toContainEqual({
          role: "tool",
          tool_call_id: "image-1",
          content: "生成结果保存失败",
        });
        const saved = await f.read("input");
        expect(saved.messages[0][2]).toMatchObject({
          type: "tool",
          data: {
            tool_call_id: "image-1",
            content: "生成结果保存失败",
            status: "error",
          },
        });
        expect(JSON.stringify(saved)).not.toContain("private-output-path");
      } finally {
        await f.close();
      }
    });

    it.each(["run", "request"])(
      "%s 取消保存取消状态，任意取消原因不进入正文",
      async (kind) => {
        const f = await captureFixture();
        const caller = new AbortController();
        try {
          const pending = f.port({ ...f.request, signal: caller.signal });
          await Promise.race([f.provider.firstRequest, pending]);
          const controller = kind === "run" ? f.controller : caller;
          controller.abort(new Error("用户已取消操作"));
          await expect(pending).rejects.toThrow();
          await vi.waitFor(async () => {
            expect(await f.summaries()).toMatchObject([
              { status: "cancelled", purpose: "goal-evaluation", usage: null },
            ]);
          });
          expect(await f.read("output")).toBeNull();
          expect(f.usageCount()).toBe(0);
          expect(caller.signal.aborted).toBe(kind === "request");
          expect(f.controller.signal.aborted).toBe(kind === "run");
        } finally {
          await f.close();
        }
      },
    );

    it("供应商流意外断开保存失败，错误正文不进入请求记录", async () => {
      const f = await captureFixture();
      try {
        const pending = f.port(f.request);
        await Promise.race([f.provider.firstRequest, pending]);
        const rejection = expect(pending).rejects.toThrow();
        await f.closeProvider();
        await rejection;
        await vi.waitFor(async () => {
          expect(await f.summaries()).toMatchObject([
            { status: "failed", httpStatus: null, usage: null },
          ]);
        });
        expect(await f.read("output")).toBeNull();
        expect(f.controller.signal.aborted).toBe(false);
        expect(f.usageCount()).toBe(0);
      } finally {
        await f.close();
      }
    });

    it.each([401, 429, 503])(
      "仅记录真实供应商的 HTTP %s 状态",
      async (status) => {
        const f = await captureFixture(status);
        try {
          await expect(f.port(f.request)).rejects.toThrow();
          expect(f.provider.requests).toHaveLength(1);
          expect(await f.summaries()).toMatchObject([
            { status: "failed", httpStatus: status, usage: null },
          ]);
          expect(await f.read("output")).toBeNull();
          expect(f.usageCount()).toBe(0);
        } finally {
          await f.close();
        }
      },
    );

    it.each([
      ["length", "length"],
      [null, undefined],
      ["fixture-private-reason", undefined],
    ])(
      "已完成请求保留已知的停止原因 %s，并忽略迟到的取消信号",
      async (providerReason, recordedReason) => {
        const f = await captureFixture();
        try {
          const pending = f.port(f.request);
          await Promise.race([f.provider.firstRequest, pending]);
          f.provider.finish(0, providerReason);
          expect(await pending).toMatchObject({
            text: "正在运行 1",
            usageObserved: false,
          });
          const before = await f.summaries();
          expect(before).toMatchObject([{ status: "completed", usage: null }]);
          const output = await f.read("output");
          expect(output).toMatchObject([
            { type: "ai", data: { content: "正在运行 1" } },
          ]);
          expect(output[0].data.finishReason).toBe(recordedReason);
          f.controller.abort(new Error("完成后取消"));
          expect(await f.summaries()).toEqual(before);
          expect(f.usageCount()).toBe(0);
        } finally {
          await f.close();
        }
      },
    );
  },
);
