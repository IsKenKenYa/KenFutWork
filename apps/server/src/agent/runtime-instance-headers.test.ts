import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { StreamEvent } from "@kenfutwork/shared";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { afterEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../config/env.js";
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

async function startStub(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, string | string[] | undefined>>;
}> {
  const requests: Array<Record<string, string | string[] | undefined>> = [];
  server = createServer((req, res) => {
    requests.push({ ...req.headers });
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
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
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
        apiKey: "sk-instance",
        protocol: "openai-compatible",
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
    },
  );

  const stream: AsyncGenerator<StreamEvent> = runtime.streamRun(runId);
  for await (const _event of stream) {
    // 工厂抛错后 run 会收尾为失败，这里只 drain
  }

  if (!captured) {
    throw new Error("runtime 未走到模型解析：夹具需要调整");
  }
  return captured;
}

describe("runtime 自定义请求头：占位符按 run 的会话取值", () => {
  it("会话 id 替换进头值并真的发到线上；同一会话两轮取同一值", async () => {
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

  it("不同会话拿到不同的头值（亲和不塌成实例级常量）", async () => {
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
