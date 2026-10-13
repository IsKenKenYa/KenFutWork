import { createServer } from "node:http";
import { modelCatalogEntrySchema } from "@kenfutwork/shared";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { countTokensApproximately } from "langchain";
import { expect, it, vi } from "vitest";
import { createRunUsageAccumulator } from "../features/usage/run-usage-accumulator.js";
import {
  createModelRequestPort,
  createRunModelRequestPort,
} from "./model-request.js";

class RequestModel extends BaseChatModel {
  requests: BaseMessage[][] = [];
  constructor(
    public answer: AIMessage = Object.assign(
      new AIMessage('{"passed":true,"reason":"Evidence"}'),
      {
        usage_metadata: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
        },
      },
    ),
  ) {
    super({ disableStreaming: true });
  }
  _llmType() {
    return "independent-request-test";
  }
  bindTools(): never {
    throw new Error("Independent request must not bind tools");
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push(messages);
    return {
      generations: [
        { message: this.answer, text: String(this.answer.content) },
      ],
    };
  }
}
const invocation = {
  providerId: "p",
  modelId: "m",
  configRevision: 3,
  body: { max_tokens: 10 },
  inputCapabilities: { image: false, pdf: false },
};
const request = {
  invocation,
  system: "Review independently",
  input: "Real receipt",
  remainingTokens: null,
};
function fixture(inputTokenLimit: number | null = null) {
  const model = new RequestModel();
  const controller = new AbortController();
  const resolve = vi.fn(async () => ({
    model,
    owner: { provider: "instance", model: "m" },
    effectiveOutputTokens: 10,
    inputTokenLimit,
  }));
  const onUsage = vi.fn(async () => {});
  return {
    model,
    controller,
    resolve,
    onUsage,
    port: createModelRequestPort({
      resolve,
      signal: controller.signal,
      onUsage,
    }),
  };
}
it("独立请求不绑定工具或历史，使用冻结配置并在返回前归账", async () => {
  const f = fixture();
  expect(await f.port(request)).toEqual({
    text: String(f.model.answer.content),
    hasToolCalls: false,
    usageObserved: true,
  });
  expect(f.model.requests).toHaveLength(1);
  expect(f.model.requests[0]?.map((message) => message.content)).toEqual([
    request.system,
    request.input,
  ]);
  expect(f.resolve).toHaveBeenNthCalledWith(1, invocation);
  expect(f.resolve).toHaveBeenNthCalledWith(2, invocation);
  expect(f.onUsage).toHaveBeenCalledWith(
    expect.objectContaining({
      inputTokens: 12,
      outputTokens: 5,
      modelCallId: expect.any(String),
      owner: { provider: "instance", model: "m" },
    }),
  );
});
it("预算不足时不发模型请求，不改变冻结输出参数", async () => {
  const f = fixture();
  await expect(f.port({ ...request, remainingTokens: 1 })).rejects.toThrow(
    "预算不足",
  );
  expect(f.model.requests).toEqual([]);
  expect(f.onUsage).not.toHaveBeenCalled();
  expect(invocation.body).toEqual({ max_tokens: 10 });
});

it("没有Goal总预算也必须在发送前拒绝超出模型窗口的完整请求", async () => {
  const f = fixture();
  const port = createModelRequestPort({
    signal: f.controller.signal,
    onUsage: f.onUsage,
    resolve: async () => ({ ...(await f.resolve()), inputTokenLimit: 100 }),
  });
  await expect(
    port({ ...request, input: "actual evidence ".repeat(2_000) }),
  ).rejects.toThrow("模型输入预算");
  expect(f.model.requests).toEqual([]);
  expect(f.onUsage).not.toHaveBeenCalled();
});

it.each(["system", "input"] as const)(
  "完整请求的%s正文都进入窗口预检",
  async (part) => {
    const f = fixture(100);
    await expect(
      f.port({ ...request, [part]: "actual request context ".repeat(2_000) }),
    ).rejects.toThrow("模型输入预算");
    expect(f.model.requests).toEqual([]);
  },
);

it("窗口输入边界允许等于上限，少一个token即拒绝且未知窗口不猜上限", async () => {
  const estimate = countTokensApproximately([
    new SystemMessage(request.system),
    new HumanMessage(request.input),
  ]);
  const equal = fixture(estimate);
  expect((await equal.port(request)).usageObserved).toBe(true);
  const smaller = fixture(estimate - 1);
  await expect(smaller.port(request)).rejects.toThrow("模型输入预算");
  expect(smaller.model.requests).toEqual([]);
  const unknown = fixture();
  expect(
    (await unknown.port({ ...request, input: "evidence ".repeat(2_000) }))
      .usageObserved,
  ).toBe(true);
});

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
  "无效输入上限%s不能发送请求",
  async (limit) => {
    const f = fixture(limit);
    await expect(f.port(request)).rejects.toThrow("模型输入预算无效");
    expect(f.model.requests).toEqual([]);
  },
);
it("取消后不发送请求", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(f.port(request)).rejects.toThrow();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.model.requests).toEqual([]);
});
it("缺少真实用量不会伪造零用量", async () => {
  const f = fixture();
  f.model.answer = new AIMessage("Review");
  expect((await f.port(request)).usageObserved).toBe(false);
  expect(f.onUsage).not.toHaveBeenCalled();
});
it("意外工具调用仅作为失败事实返回，绝不执行", async () => {
  const f = fixture();
  f.model.answer = new AIMessage({
    content: "",
    tool_calls: [
      { name: "Bash", args: { command: "touch result" }, id: "unexpected" },
    ],
  });
  expect((await f.port(request)).hasToolCalls).toBe(true);
  expect(f.model.requests).toHaveLength(1);
});
it("评估期间配置修订变化拒绝返回结果，但已产生用量仍归账", async () => {
  const f = fixture();
  f.resolve.mockImplementationOnce(async () => ({
    model: f.model,
    owner: { provider: "instance", model: "m" },
    effectiveOutputTokens: 10,
    inputTokenLimit: null,
  }));
  f.resolve.mockRejectedValueOnce(new Error("配置已改变"));
  await expect(f.port(request)).rejects.toThrow("配置已改变");
  expect(f.onUsage).toHaveBeenCalledTimes(1);
});

it("真实协议适配器发送冻结无工具请求，用量加入原Run账本并发布累计值", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        id: "review",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: '{"passed":false,"reason":"Missing file"}',
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No stub port");
    const providerId = "00000000-0000-4000-8000-000000000001";
    const actor = { instanceId: "instance", accessClientId: null };
    const usage = createRunUsageAccumulator();
    usage.update("run", "execution", {
      instanceId: actor.instanceId,
      accessClientId: null,
      provider: "instance",
      model: "m",
      providerInstanceId: providerId,
      inputTokens: 100,
      outputTokens: 20,
    });
    const publish = vi.fn(async () => {});
    const entry = modelCatalogEntrySchema.parse({
      id: "m",
      name: "M",
      capability: "chat",
      model: {
        id: "m",
        name: "M",
        capability: "chat",
        contextWindow: 256,
        maxOutputTokens: 9_999,
      },
      provider: {
        instanceId: providerId,
        name: "stub",
        protocol: "openai-compatible",
        scope: "local",
      },
    });
    const catalog = {
      validateSpecifier: async (): Promise<{ ok: true }> => ({ ok: true }),
      listCatalog: vi.fn(async () => [
        {
          ...entry,
          provider: {
            ...entry.provider,
            instanceId: "00000000-0000-4000-8000-000000000002",
          },
          model: { ...entry.model, contextWindow: 1 },
        },
        entry,
      ]),
    };
    const port = createRunModelRequestPort({
      actor,
      runId: "run",
      sessionId: "task",
      threadId: "thread",
      signal: new AbortController().signal,
      usage,
      publish,
      assertCurrent: () => {},
      now: () => "2026-10-13T00:00:00.000Z",
      catalog,
      providers: {
        resolveCredentials: async () => ({
          instanceId: providerId,
          name: "stub",
          protocol: "openai-compatible",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "synthetic-test-key",
          configRevision: 3,
          models: [],
        }),
      },
    });
    await expect(
      port({
        ...request,
        invocation: { ...invocation, providerId },
        input: "real evidence ".repeat(2_000),
      }),
    ).rejects.toThrow("模型输入预算");
    expect(bodies).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    expect(
      await port({ ...request, invocation: { ...invocation, providerId } }),
    ).toEqual({
      text: '{"passed":false,"reason":"Missing file"}',
      hasToolCalls: false,
      usageObserved: true,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "m", max_tokens: 10 });
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(bodies[0]).not.toHaveProperty("tool_choice");
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run.usage",
        runId: "run",
        inputTokens: 12,
        outputTokens: 5,
        runInputTokens: 112,
        runOutputTokens: 25,
      }),
    );
    expect(usage.take("run")).toEqual([
      expect.objectContaining({ inputTokens: 112, outputTokens: 25 }),
    ]);
    catalog.listCatalog.mockRejectedValueOnce(new Error("catalog unavailable"));
    await expect(
      port({ ...request, invocation: { ...invocation, providerId } }),
    ).rejects.toThrow("catalog unavailable");
    expect(bodies).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("供应商忽略取消时宿主仍退出独立请求，迟到结果不能归账", async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    f.model._generate = async () => {
      resolve();
      await new Promise<void>((finish) => {
        release = finish;
      });
      return { generations: [{ message: f.model.answer, text: "Review" }] };
    };
  });
  const pending = f.port(request);
  await started;
  f.controller.abort();
  await expect(pending).rejects.toThrow();
  release?.();
  await Promise.resolve();
  expect(f.onUsage).not.toHaveBeenCalled();
});
