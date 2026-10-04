import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { StreamEvent } from "@kenfutwork/shared";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { afterEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../config/env.js";
import type { ModelInvocationSnapshot } from "../providers/types.js";
import { createAgentRunService } from "./runtime.js";

/**
 * 自定义请求头在 **runtime → 适配器 → 线上** 的整链验证（§4.8 验收用例）。
 *
 * 验收口径（规格原文）：用 `{{sessionId}}` 的实例跑一次对话，
 * 「同一会话多轮拿到同一个值（亲和成立）、不同会话值不同」。
 * 这里用桩服务截获真实请求头来断言——只测渲染函数不足以证明 run 把会话 id 接对了。
 */

const INSTANCE_ID = "73270d3f-fbef-4ae3-ae13-645862e7fc62";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = undefined;
  });
});

async function startStub(reject = false): Promise<{
  baseUrl: string;
  requests: Array<Record<string, string | string[] | undefined>>;
  bodies: Array<Record<string, unknown>>;
  paths: string[];
}> {
  const requests: Array<Record<string, string | string[] | undefined>> = [];
  const bodies: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  const stub = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    bodies.push(JSON.parse(body));
    requests.push({ ...req.headers });
    paths.push(req.url ?? "");
    if (reject) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "request captured" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  // afterEach 负责关停：登记到模块级变量（stub 是它的非空别名）
  server = stub;
  await new Promise<void>((resolve) => {
    stub.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = stub.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, bodies, paths };
}

function makeEnv(): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
  };
}

/** 跑到 agent 工厂即截获模型并停下——本用例只关心模型是怎么造出来的。 */
async function resolveModelForRun(input: {
  baseUrl: string;
  sessionId: string;
  threadId: string;
  modelInvocation?: ModelInvocationSnapshot;
  probedResponses?: boolean;
}): Promise<BaseLanguageModel> {
  let captured: BaseLanguageModel | undefined;
  const runtime = createAgentRunService({
    agentFactory: (agentOptions) => {
      captured = agentOptions.model as BaseLanguageModel;
      throw new Error("stop-after-model-resolution");
    },
    blob: { upload: async () => ({}) } as never,
    env: makeEnv(),
    modelProviders: {
      getInstanceScope: async () => "workspace",
      resolveCredentials: async () => ({
        instanceId: INSTANCE_ID,
        configRevision: 1,
        models: [
          {
            id: "glm-test",
            name: "model",
            capability: "chat",
            extraBody: { legacy: "old", max_tokens: 999 },
          },
        ],
        apiKey: "sk-instance",
        protocol: "openai-compatible",
        ...(input.probedResponses !== undefined
          ? { responsesApi: input.probedResponses }
          : {}),
        baseUrl: input.baseUrl,
        headers: {
          "x-opencode-session": "{{sessionId}}",
          "x-tenant-id": "ws-42",
        },
      }),
    } as never,
    viewerService: {
      resolveWorkspace: async () => ({ id: "ws-headers-test" }),
    } as never,
    agentPersistenceService: {
      getPersistence: async () => ({ checkpointer: null, store: null }),
    } as never,
    agentRunMetadataService: {
      updateRun: async () => {},
    } as never,
  });

  const { runId } = runtime.createRun(
    {
      canvasId: "conv-headers-1",
      conversationId: "conv-headers-1",
      prompt: "你好",
      sessionId: input.sessionId,
    },
    {
      accessToken: "tok",
      model: `${INSTANCE_ID}:glm-test`,
      threadId: input.threadId,
      userId: "u-headers",
      ...(input.modelInvocation
        ? { modelInvocation: input.modelInvocation }
        : {}),
    },
  );

  const stream: AsyncGenerator<StreamEvent> = runtime.streamRun(runId);
  let failure: string | undefined;
  for await (const event of stream) {
    if (event.type === "run.failed") failure = event.error.message;
    // 工厂抛错后 run 会收尾为失败，这里只 drain
  }

  if (!captured) {
    throw new Error(failure ?? "runtime 未走到模型解析：夹具需要调整");
  }
  return captured;
}

describe("runtime 自定义请求头：占位符按 run 的会话取值", () => {
  it("原UI明确选择Completions的false快照覆盖供应商Responses探测，真实HTTP路径一致", async () => {
    const stub = await startStub(true);
    const model = await resolveModelForRun({
      baseUrl: stub.baseUrl,
      sessionId: "dialect-session",
      threadId: "dialect-thread",
      probedResponses: true,
      modelInvocation: {
        providerId: INSTANCE_ID,
        modelId: "glm-test",
        configRevision: 1,
        useResponsesApi: false,
        body: {},
        inputCapabilities: { image: false, pdf: false },
      },
    });
    await model.invoke("验证实际方言").catch(() => undefined);
    expect(stub.paths).toEqual(["/v1/chat/completions"]);
  });
  it("共同Harness把本轮冻结参数送到实际HTTP，不重并静态extraBody复活已删除字段", async () => {
    const stub = await startStub(true);
    const model = await resolveModelForRun({
      baseUrl: stub.baseUrl,
      sessionId: "selected-session",
      threadId: "selected-thread",
      modelInvocation: {
        providerId: INSTANCE_ID,
        modelId: "glm-test",
        configRevision: 1,
        body: { max_tokens: 321, flag: false },
        inputCapabilities: { image: false, pdf: false },
      },
    });
    await model.invoke("原始输入").catch(() => undefined);
    expect(stub.bodies).toHaveLength(1);
    expect(stub.bodies[0]).toMatchObject({
      model: "glm-test",
      max_tokens: 321,
      flag: false,
    });
    expect(stub.bodies[0]).not.toHaveProperty("legacy");
    expect(stub.requests[0]?.["x-opencode-session"]).toBe("selected-session");
    expect(stub.requests[0]?.authorization).toBe("Bearer sk-instance");
  });
  it("配置修订或模型身份改变时真实Run可读失败，拒绝调用旧参数的模型", async () => {
    const stub = await startStub(true);
    for (const changed of [
      { configRevision: 2 },
      { providerId: "other-provider" },
      { modelId: "other-model" },
    ]) {
      await expect(
        resolveModelForRun({
          baseUrl: stub.baseUrl,
          sessionId: "selected-session",
          threadId: "selected-thread",
          modelInvocation: {
            providerId: INSTANCE_ID,
            modelId: "glm-test",
            configRevision: 1,
            body: { max_tokens: 321 },
            inputCapabilities: { image: false, pdf: false },
            ...changed,
          },
        }),
      ).rejects.toThrow("本轮供应商或模型配置已改变");
    }
    expect(stub.bodies).toHaveLength(0);
  });
  // 豁免（2026-09-27，诊断见《日志》五十五 补记）：@langchain/openai 1.5.13 的
  // ChatOpenAI 流式消费对手写 SSE 桩永不结算（详见 instance-headers.test.ts 同款注记）。
  it.skip("会话 id 替换进头值并真的发到线上；同一会话两轮取同一值", async () => {
    const stub = await startStub();
    const model = await resolveModelForRun({
      baseUrl: stub.baseUrl,
      sessionId: "sess-runtime-1",
      threadId: "thread-runtime-1",
    });

    await model.invoke("第一轮");
    await model.invoke("第二轮");

    expect(stub.requests).toHaveLength(2);
    for (const headers of stub.requests) {
      expect(headers["x-opencode-session"]).toBe("sess-runtime-1");
      expect(headers["x-tenant-id"]).toBe("ws-42");
      // 保留头没被自定义头顶掉
      expect(headers.authorization).toBe("Bearer sk-instance");
    }
  });

  it.skip("不同会话拿到不同的头值（亲和不塌成实例级常量）", async () => {
    const first = await startStub();
    const firstModel = await resolveModelForRun({
      baseUrl: first.baseUrl,
      sessionId: "sess-a",
      threadId: "t-a",
    });
    await firstModel.invoke("hi");
    expect(first.requests[0]?.["x-opencode-session"]).toBe("sess-a");

    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
      server = undefined;
    });

    const second = await startStub();
    const secondModel = await resolveModelForRun({
      baseUrl: second.baseUrl,
      sessionId: "sess-b",
      threadId: "t-b",
    });
    await secondModel.invoke("hi");
    expect(second.requests[0]?.["x-opencode-session"]).toBe("sess-b");
  });
});
