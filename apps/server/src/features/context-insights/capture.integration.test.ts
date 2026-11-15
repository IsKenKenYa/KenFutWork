import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createModelRequestPort } from "../../agent/model-request.js";
import { createInstanceChatModel } from "../../providers/openai-compatible/index.js";
import { heldModel } from "../code-ui/model-stream.fixture.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createContextRequestCallbacks } from "./capture.js";
import { createContextInspectionService } from "./service.js";

async function captureFixture() {
  const database = await createTaskWorkDatabase();
  const provider = await heldModel();
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
    async output() {
      const request = (
        await service.list(database.actor, { taskId: owner.taskId })
      ).requests[0];
      if (!request) throw new Error("请求记录尚未保存");
      return JSON.parse(
        (
          await service.read(database.actor, {
            taskId: owner.taskId,
            requestId: request.id,
            part: "output",
          })
        ).text,
      );
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
          expect(await f.output()).toBeNull();
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
            { status: "failed", usage: null },
          ]);
        });
        expect(await f.output()).toBeNull();
        expect(f.controller.signal.aborted).toBe(false);
        expect(f.usageCount()).toBe(0);
      } finally {
        await f.close();
      }
    });

    it("模型完成后收到取消信号保持已完成记录，未上报用量保持未知", async () => {
      const f = await captureFixture();
      try {
        const pending = f.port(f.request);
        await Promise.race([f.provider.firstRequest, pending]);
        f.provider.finish(0);
        expect(await pending).toMatchObject({
          text: "正在运行 1",
          usageObserved: false,
        });
        const before = await f.summaries();
        expect(before).toMatchObject([{ status: "completed", usage: null }]);
        f.controller.abort(new Error("完成后取消"));
        expect(await f.summaries()).toEqual(before);
        expect(f.usageCount()).toBe(0);
      } finally {
        await f.close();
      }
    });
  },
);
