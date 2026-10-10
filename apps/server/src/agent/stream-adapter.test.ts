import type { StreamEvent } from "@kenfutwork/shared";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  type StandardMessageStructure,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  MODEL_USAGE_OWNER_METADATA,
  type ModelCallUsage,
} from "./model-call-usage.js";
import { adaptDeepAgentStream } from "./stream-adapter.js";

/** 停滞流：首次 next() 之后永不产出（模拟上游首 token 后卡死）。 */
function stalledStream() {
  let calls = 0;
  const stream: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve({
              done: false,
              value: {
                event: "on_chat_model_start",
                run_id: "stalled-model",
              },
            });
          }
          // 之后永远挂起
          return new Promise<IteratorResult<unknown>>(() => {});
        },
        return: () =>
          Promise.resolve({ done: true, value: undefined as never }),
      };
    },
  };
  return stream;
}

async function collect(
  stream: AsyncIterable<unknown>,
  options: {
    signal?: AbortSignal;
    idleTimeoutMs?: number;
    abortRun?: () => void;
    canonicalToolEvents?: boolean;
  },
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of adaptDeepAgentStream({
    conversationId: "conv-1",
    runId: "run-1",
    sessionId: "sess-1",
    stream,
    ...options,
  })) {
    events.push(event);
  }
  return events;
}

/**
 * 回归（GUI 实测事故）：上游停滞时适配器的 `for await` 曾永久阻塞 →
 * run 卡 running 数分钟、且「停止」的取消信号传不进去（只在事件到达时才检查）。
 */
describe("stream-adapter 停滞与取消", () => {
  it("模型已返回工具调用后，人审等待超过模型空闲阈值仍可完成，不误报上游停滞", async () => {
    const awaitingApproval: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield { event: "on_chat_model_start", run_id: "approval-model" };
        yield {
          event: "on_chat_model_end",
          run_id: "approval-model",
          data: {
            output: new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "needs-approval",
                  name: "Bash",
                  args: { command: "printf approved" },
                },
              ],
            }),
          },
        };
        yield {
          event: "on_custom_event",
          name: "kenfutwork.tool",
          data: {
            phase: "started",
            toolCallId: "needs-approval",
            toolName: "Bash",
            input: { command: "printf approved" },
          },
        };
        await new Promise((resolve) => setTimeout(resolve, 150));
        yield {
          event: "on_custom_event",
          name: "kenfutwork.tool",
          data: {
            phase: "completed",
            toolCallId: "needs-approval",
            toolName: "Bash",
            output: "approved",
          },
        };
        yield { event: "on_chat_model_start", run_id: "after-approval-model" };
        yield {
          event: "on_chat_model_end",
          run_id: "after-approval-model",
          data: { output: new AIMessage("AFTER_APPROVAL_COMPLETED") },
        };
      },
    };
    const events = await collect(awaitingApproval, {
      idleTimeoutMs: 40,
      canonicalToolEvents: true,
    });
    expect(
      events.filter((event) => event.type === "tool.completed"),
    ).toContainEqual(
      expect.objectContaining({
        toolName: "Bash",
        toolCallId: "needs-approval",
      }),
    );
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.filter((event) => event.type === "run.failed")).toEqual([]);
  });

  it("上游停滞超过阈值：以 run.failed 有界收尾，且文案可读（非通用提示）", async () => {
    let aborted = false;
    const events = await collect(stalledStream(), {
      idleTimeoutMs: 40,
      abortRun: () => {
        aborted = true;
      },
    });

    expect(events[0]?.type).toBe("run.started");
    const last = events.at(-1);
    expect(last?.type).toBe("run.failed");
    expect((last as { error?: { message?: string } }).error?.message).toContain(
      "没有任何输出",
    );
    // 超时同时中止底层请求（释放上游连接）
    expect(aborted).toBe(true);
  });

  it("停滞期中止：以 run.canceled 收尾（界面「停止」按钮真正生效）", async () => {
    const controller = new AbortController();
    const consuming = collect(stalledStream(), {
      idleTimeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);

    const startedAt = Date.now();
    const events = await consuming;
    expect(events.at(-1)?.type).toBe("run.canceled");
    // 远早于空闲阈值返回，证明取消不必等事件到达
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("真实接线（signal 与 abortRun 同一控制器）：停滞报 run.failed 而非 run.canceled", async () => {
    // 运行时的真实接法：onIdle 中止的信号同时是取消信号。若先判 aborted，
    // 上游故障会被误报成「用户取消」——E2E 实测踩中，本用例锁死判定顺序。
    const controller = new AbortController();
    const events = await collect(stalledStream(), {
      idleTimeoutMs: 40,
      signal: controller.signal,
      abortRun: () => controller.abort(),
    });

    expect(controller.signal.aborted).toBe(true);
    const last = events.at(-1);
    expect(last?.type).toBe("run.failed");
    expect((last as { error?: { message?: string } }).error?.message).toContain(
      "没有任何输出",
    );
  });

  it("已中止的信号：进入即取消，不消费上游", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(stalledStream(), {
      signal: controller.signal,
    });
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.canceled"]);
  });

  it("正常结束的流仍以 run.completed 收尾（未误判为取消）", async () => {
    const stream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield undefined;
      },
    };
    const events = await collect(stream, { idleTimeoutMs: 1000 });
    expect(events.at(-1)?.type).toBe("run.completed");
  });
});

/**
 * 联网搜索的来源必须真的到达客户端：`web_search` 的返回是 `{query, results}`，
 * 事件里要能原样看到 results（客户端据此渲染可点击来源）。
 * 这条缝此前没被任何测试覆盖——服务端工具测试只验工具本身，
 * 客户端解析测试只验形状，中间「事件是否携带输出」是断的。
 */
describe("工具输出透传（web_search 来源可达客户端）", () => {
  const searchPayload = {
    query: "今天天气",
    results: [
      { title: "中国天气网", link: "https://weather.com.cn/a", content: "晴" },
      { title: "另一来源", link: "https://example.com/b", content: "多云" },
    ],
  };

  function toolEndStream(output: unknown): AsyncIterable<unknown> {
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          event: "on_tool_start",
          name: "web_search",
          run_id: "call-1",
          data: { input: { query: "今天天气" } },
        };
        yield {
          event: "on_tool_end",
          name: "web_search",
          run_id: "call-1",
          data: { output },
        };
      },
    };
  }

  it("纯文本工具结果保留完整 outputText，供原终端与文件 renderer 使用", async () => {
    const output = "第一行\n第二行：中文与 emoji 🌱\n";
    const events = await collect(toolEndStream(output), {});
    const completed = events.find((event) => event.type === "tool.completed");
    if (completed?.type !== "tool.completed") throw new Error("缺少工具终态");

    expect(completed.outputText).toBe(output);
  });

  it("大于旧 10KB 限制的结构化结果仍完整到达公共事件接口", async () => {
    const payload = { content: "完整结果🌱".repeat(4_000) };
    const events = await collect(toolEndStream(payload), {});
    const completed = events.find((event) => event.type === "tool.completed");
    if (completed?.type !== "tool.completed") throw new Error("缺少工具终态");

    expect(completed.output).toEqual(payload);
  });

  it("工具返回 error ToolMessage 时，公共终态明确为 error", async () => {
    const events = await collect(
      toolEndStream(
        new ToolMessage({
          tool_call_id: "call-1",
          content: "命令执行失败：退出码 2",
          status: "error",
        }),
      ),
      {},
    );
    const completed = events.find((event) => event.type === "tool.completed");
    if (completed?.type !== "tool.completed") throw new Error("缺少工具终态");

    expect(completed.status).toBe("error");
  });

  it("对象形态输出：tool.completed.output 携带 query 与 results", async () => {
    const events = await collect(toolEndStream(searchPayload), {});
    const completed = events.find((e) => e.type === "tool.completed") as
      | { output?: Record<string, unknown> }
      | undefined;

    expect(completed).toBeDefined();
    expect(completed?.output?.query).toBe("今天天气");
    expect(Array.isArray(completed?.output?.results)).toBe(true);
    const results = completed?.output?.results as Array<{ link: string }>;
    expect(results.map((r) => r.link)).toEqual([
      "https://weather.com.cn/a",
      "https://example.com/b",
    ]);
  });

  it("JSON 字符串输出：同样被解析为结构化 output（客户端解析器直接可用）", async () => {
    const events = await collect(
      toolEndStream(JSON.stringify(searchPayload)),
      {},
    );
    const completed = events.find((e) => e.type === "tool.completed") as
      | { output?: Record<string, unknown> }
      | undefined;
    expect(completed?.output?.query).toBe("今天天气");
    expect((completed?.output?.results as unknown[] | undefined)?.length).toBe(
      2,
    );
  });
});

/**
 * 回归（GUI 全流程实测）：工具抛错时 LangChain 发 `on_tool_error`（不发 `on_tool_end`），
 * 适配器没有对应分支 → 客户端工具块**永远停在 status:"running"**（转圈的假象），
 * 用户既看不到失败、也看不到原因。这条支路必须以终态事件收尾并带上可读原因。
 */
describe("工具抛错：以终态事件收尾并带可读原因", () => {
  function toolErrorStream(error: unknown): AsyncIterable<unknown> {
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          event: "on_tool_start",
          name: "web_search",
          run_id: "call-err-1",
          data: { input: { query: "python 教程" } },
        };
        yield {
          event: "on_tool_error",
          name: "web_search",
          run_id: "call-err-1",
          data: { error },
        };
      },
    };
  }

  it("on_tool_error → tool.completed，outputSummary 带「失败：」与可读原因", async () => {
    const events = await collect(
      toolErrorStream(
        new Error("web_search 请求失败（API密钥无效），请检查搜索供应商配置。"),
      ),
      {},
    );
    const completed = events.find((e) => e.type === "tool.completed") as
      | { outputSummary?: string; output?: Record<string, unknown> }
      | undefined;

    expect(completed).toBeDefined();
    expect(completed?.outputSummary).toContain("失败：");
    expect(completed?.outputSummary).toContain("API密钥无效");
    expect(completed?.output?.error).toContain("API密钥无效");
  });

  it("被包装的工具错误（cause 链）：取最内层的可读文案", async () => {
    const inner = new Error(
      "web_search 请求失败（429），请检查搜索供应商配置。",
    );
    const wrapped = new Error("Tool execution failed", { cause: inner });
    const events = await collect(toolErrorStream(wrapped), {});
    const completed = events.find((e) => e.type === "tool.completed") as
      | { outputSummary?: string }
      | undefined;

    expect(completed?.outputSummary).toContain("429");
  });

  it("message 带堆栈时不透出内部路径（只取首行）", async () => {
    const withStack = new Error(
      [
        "web_search 请求失败（API密钥无效），请检查搜索供应商配置。",
        "WebSearchError: 同上",
        "    at Object.execute (/repo/apps/server/src/features/search/web-search.ts:152:15)",
      ].join("\n"),
    );
    const events = await collect(toolErrorStream(withStack), {});
    const completed = events.find((e) => e.type === "tool.completed") as
      | { outputSummary?: string }
      | undefined;

    expect(completed?.outputSummary).toBe(
      "失败：web_search 请求失败（API密钥无效），请检查搜索供应商配置。",
    );
    expect(completed?.outputSummary).not.toContain("at Object.execute");
  });

  it("错误对象缺失时不产出空文案块（有兜底文案）", async () => {
    const events = await collect(toolErrorStream(undefined), {});
    const completed = events.find((e) => e.type === "tool.completed") as
      | { outputSummary?: string }
      | undefined;
    expect(completed?.outputSummary).toContain("失败：");
  });
});

/**
 * 用量快照事件（R4-1 上下文容量 / 缓存命中浮层的唯一数据源）。
 * 实际用量变化下发；同 call 的重复绝对值不重复投影，正文chunk不额外灌用量事件。
 * 真实 SDK call ID 是调用边界；缓存字段上游不报时不许编 0。
 */
const modelUsageOwner = {
  provider: "openai-compatible",
  model: "stop-model",
  providerInstanceId: "provider-1",
  configRevision: 1,
};

function usageChunk(inputTokens: number, cacheRead?: number, outputTokens = 3) {
  return new AIMessageChunk<StandardMessageStructure>({
    content: "",
    usage_metadata: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cacheRead === undefined
        ? {}
        : { input_token_details: { cache_read: cacheRead } }),
    },
  });
}

function chunkStream(
  modelCallId: string,
  chunks: AIMessageChunk<StandardMessageStructure>[],
  output:
    | AIMessage<StandardMessageStructure>
    | AIMessageChunk<StandardMessageStructure>
    | undefined = chunks.at(-1),
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        event: "on_chat_model_start",
        run_id: modelCallId,
        metadata: { [MODEL_USAGE_OWNER_METADATA]: modelUsageOwner },
        data: { input: { messages: [] } },
      };
      for (const chunk of chunks) {
        yield {
          event: "on_chat_model_stream",
          run_id: modelCallId,
          data: { chunk },
        };
      }
      yield {
        event: "on_chat_model_end",
        run_id: modelCallId,
        data: { output },
      };
    },
  };
}

describe("stream-adapter 用量快照", () => {
  async function collectUsage(
    stream: AsyncIterable<unknown>,
    onUsage?: Parameters<typeof adaptDeepAgentStream>[0]["onUsage"],
  ) {
    const events: StreamEvent[] = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conv-1",
      runId: "run-1",
      sessionId: "sess-1",
      stream,
      ...(onUsage ? { onUsage } : {}),
    })) {
      events.push(event);
    }
    return events;
  }

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "非法模型用量 %s 不入账、不污染累计，也不阻断原正文与完成",
    async (tokens) => {
      const seen: ModelCallUsage[] = [];
      const events = await collectUsage(
        chunkStream(
          "call-a",
          [usageChunk(tokens), usageChunk(10)],
          new AIMessage<StandardMessageStructure>({ content: "完成正文" }),
        ),
        (usage) => {
          seen.push(usage);
        },
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ inputTokens: 10, outputTokens: 3 });
      expect(events.filter((event) => event.type === "run.usage")).toEqual([
        expect.objectContaining({
          inputTokens: 10,
          runInputTokens: 10,
          runOutputTokens: 3,
        }),
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "message.delta", delta: "完成正文" }),
      );
      expect(events.at(-1)?.type).toBe("run.completed");
    },
  );

  it("带缓存字段的用量下发一次 run.usage（含 cachedInputTokens）", async () => {
    const seen: ModelCallUsage[] = [];
    const events: StreamEvent[] = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conv-1",
      runId: "run-1",
      sessionId: "sess-1",
      stream: chunkStream("call-a", [usageChunk(1200, 1000)]),
      onUsage: (usage) => {
        seen.push(usage);
      },
    })) {
      events.push(event);
    }

    const usageEvents = events.filter((event) => event.type === "run.usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: "run.usage",
      runId: "run-1",
      modelCallId: "call-a",
      inputTokens: 1200,
      cachedInputTokens: 1000,
    });
    expect(seen[0]).toMatchObject({
      modelCallId: "call-a",
      owner: modelUsageOwner,
      inputTokens: 1200,
      outputTokens: 3,
      cachedInputTokens: 1000,
    });
  });

  it("用量旁路拒绝写入时仍发布真实正文和完成，不把采集失败变成Run失败", async () => {
    const events = await collectUsage(
      chunkStream(
        "call-a",
        [usageChunk(10)],
        new AIMessage<StandardMessageStructure>({ content: "完成正文" }),
      ),
      () => {
        throw new Error("test-usage-storage-unavailable");
      },
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "run.usage",
        runInputTokens: 10,
        runOutputTokens: 3,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message.delta", delta: "完成正文" }),
    );
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("停止前最后的实际用量增长已可见，即使上游没有模型end事件", async () => {
    const controller = new AbortController();
    const stream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield {
          event: "on_chat_model_stream",
          run_id: "call-a",
          data: { chunk: usageChunk(10, undefined, 1) },
        };
        yield {
          event: "on_chat_model_stream",
          run_id: "call-a",
          data: { chunk: usageChunk(10, undefined, 7) },
        };
        controller.abort();
      },
    };
    const events = await collect(stream, { signal: controller.signal });
    expect(
      events.filter((event) => event.type === "run.usage").at(-1),
    ).toMatchObject({
      modelCallId: "call-a",
      runInputTokens: 10,
      runOutputTokens: 7,
    });
    expect(events.at(-1)?.type).toBe("run.canceled");
  });

  it("同一 call 的重复 chunk/end 只下发一次（不逐 chunk 灌 WS）", async () => {
    const events: StreamEvent[] = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conv-1",
      runId: "run-1",
      sessionId: "sess-1",
      stream: chunkStream("call-a", [
        usageChunk(500),
        usageChunk(500),
        usageChunk(500),
      ]),
    })) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "run.usage")).toHaveLength(
      1,
    );
  });

  it("工具轮次是两个明确 call，各自用量与 Run 总量同时下发", async () => {
    const stream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield* chunkStream("call-a", [usageChunk(500)]);
        yield* chunkStream("call-b", [usageChunk(1500, 1200)]);
      },
    };
    const events: StreamEvent[] = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conv-1",
      runId: "run-1",
      sessionId: "sess-1",
      stream,
    })) {
      events.push(event);
    }
    const usageEvents = events.filter((event) => event.type === "run.usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[1]).toMatchObject({
      modelCallId: "call-b",
      inputTokens: 1500,
      cachedInputTokens: 1200,
      runInputTokens: 2000,
      runOutputTokens: 6,
    });
  });

  it("上游不报缓存：事件里没有 cachedInputTokens 字段（不编 0）", async () => {
    const events: StreamEvent[] = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conv-1",
      runId: "run-1",
      sessionId: "sess-1",
      stream: chunkStream("call-a", [usageChunk(800)]),
    })) {
      events.push(event);
    }
    const usage = events.find((event) => event.type === "run.usage");
    expect(usage).toBeDefined();
    expect(usage).not.toHaveProperty("cachedInputTokens");
  });

  it("不同 call 的相同 input=10 分别累计，void 回调仍投影 Run 总 20/10", async () => {
    const seen: ModelCallUsage[] = [];
    const stream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield* chunkStream("call-a", [usageChunk(10, undefined, 3)]);
        yield* chunkStream("call-b", [usageChunk(10, undefined, 7)]);
      },
    };
    const events = await collectUsage(stream, (usage) => {
      seen.push(usage);
    });
    const usageEvents = events.filter((event) => event.type === "run.usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({
      modelCallId: "call-a",
      inputTokens: 10,
      outputTokens: 3,
      runInputTokens: 10,
      runOutputTokens: 3,
    });
    expect(usageEvents[1]).toMatchObject({
      modelCallId: "call-b",
      inputTokens: 10,
      outputTokens: 7,
      runInputTokens: 20,
      runOutputTokens: 10,
    });
    expect(seen.map((usage) => usage.modelCallId)).toEqual([
      "call-a",
      "call-a",
      "call-b",
      "call-b",
    ]);
  });

  it("同 call 实际用量增长及end修正绝对值可见，并保留已知缓存", async () => {
    const events = await collectUsage(
      chunkStream(
        "call-a",
        [usageChunk(10, 4, 1), usageChunk(10, undefined, 2)],
        new AIMessage<StandardMessageStructure>({
          content: "",
          usage_metadata: {
            input_tokens: 10,
            output_tokens: 7,
            total_tokens: 17,
          },
        }),
      ),
    );
    const usageEvents = events.filter((event) => event.type === "run.usage");
    expect(usageEvents).toHaveLength(3);
    expect(usageEvents[0]).toMatchObject({
      modelCallId: "call-a",
      inputTokens: 10,
      outputTokens: 1,
      runInputTokens: 10,
      runOutputTokens: 1,
    });
    expect(usageEvents[1]).toMatchObject({
      outputTokens: 2,
      runOutputTokens: 2,
    });
    expect(usageEvents[2]).toMatchObject({
      modelCallId: "call-a",
      inputTokens: 10,
      outputTokens: 7,
      cachedInputTokens: 4,
      runInputTokens: 10,
      runOutputTokens: 7,
      runCachedInputTokens: 4,
    });
  });

  it("onUsage 回传整个 Run 的绝对 totals 时，投影直接采用该总量", async () => {
    const seen: ModelCallUsage[] = [];
    const events = await collectUsage(
      chunkStream("call-a", [usageChunk(10, 4, 7)]),
      (usage) => {
        seen.push(usage);
        return { inputTokens: 110, outputTokens: 17, cachedInputTokens: 50 };
      },
    );
    expect(events.filter((event) => event.type === "run.usage")).toEqual([
      expect.objectContaining({
        modelCallId: "call-a",
        inputTokens: 10,
        outputTokens: 7,
        cachedInputTokens: 4,
        runInputTokens: 110,
        runOutputTokens: 17,
        runCachedInputTokens: 50,
      }),
    ]);
    expect(seen).toEqual([
      {
        modelCallId: "call-a",
        inputTokens: 10,
        outputTokens: 7,
        cachedInputTokens: 4,
        owner: modelUsageOwner,
      },
      {
        modelCallId: "call-a",
        inputTokens: 10,
        outputTokens: 7,
        cachedInputTokens: 4,
        owner: modelUsageOwner,
      },
    ]);
  });

  it("非流式模型 end 同时保留正文与完整用量", async () => {
    const seen: ModelCallUsage[] = [];
    const events = await collectUsage(
      chunkStream(
        "call-a",
        [],
        new AIMessage<StandardMessageStructure>({
          id: "nonstream-message",
          content: "完整正文",
          usage_metadata: {
            input_tokens: 10,
            output_tokens: 7,
            total_tokens: 17,
          },
        }),
      ),
      (usage) => {
        seen.push(usage);
      },
    );
    expect(events.filter((event) => event.type === "run.usage")).toEqual([
      expect.objectContaining({
        modelCallId: "call-a",
        inputTokens: 10,
        outputTokens: 7,
        runInputTokens: 10,
        runOutputTokens: 7,
      }),
    ]);
    expect(events.filter((event) => event.type === "message.delta")).toEqual([
      expect.objectContaining({
        messageId: "nonstream-message",
        delta: "完整正文",
      }),
    ]);
    expect(seen).toEqual([
      {
        modelCallId: "call-a",
        inputTokens: 10,
        outputTokens: 7,
        owner: modelUsageOwner,
      },
    ]);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("Read tool-call 的 stream/end 在正文过滤前计量且不重复累计", async () => {
    const chunk = new AIMessageChunk<StandardMessageStructure>({
      content: "",
      tool_calls: [
        {
          name: "Read",
          args: { file_path: "usage-read.txt" },
          id: "read-call",
          type: "tool_call",
        },
      ],
      usage_metadata: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    });
    const output = new AIMessage<StandardMessageStructure>({
      content: "",
      tool_calls: [
        {
          name: "Read",
          args: { file_path: "usage-read.txt" },
          id: "read-call",
          type: "tool_call",
        },
      ],
      usage_metadata: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    });
    const seen: ModelCallUsage[] = [];
    const events = await collectUsage(
      chunkStream("call-a", [chunk], output),
      (usage) => {
        seen.push(usage);
      },
    );
    expect(events.filter((event) => event.type === "run.usage")).toEqual([
      expect.objectContaining({
        modelCallId: "call-a",
        inputTokens: 10,
        outputTokens: 3,
        runInputTokens: 10,
        runOutputTokens: 3,
      }),
    ]);
    expect(events.filter((event) => event.type === "message.delta")).toEqual(
      [],
    );
    expect(seen).toEqual([
      {
        modelCallId: "call-a",
        inputTokens: 10,
        outputTokens: 3,
        owner: modelUsageOwner,
      },
      {
        modelCallId: "call-a",
        inputTokens: 10,
        outputTokens: 3,
        owner: modelUsageOwner,
      },
    ]);
  });

  it("正文已流式输出时，end 去重正文仍保留完整用量", async () => {
    const events = await collectUsage(
      chunkStream(
        "call-a",
        [
          new AIMessageChunk<StandardMessageStructure>({
            id: "streamed-message",
            content: "流式正文",
          }),
        ],
        new AIMessage<StandardMessageStructure>({
          id: "streamed-message",
          content: "流式正文",
          usage_metadata: {
            input_tokens: 10,
            output_tokens: 7,
            total_tokens: 17,
          },
        }),
      ),
    );
    expect(events.filter((event) => event.type === "message.delta")).toEqual([
      expect.objectContaining({
        messageId: "streamed-message",
        delta: "流式正文",
      }),
    ]);
    expect(events.filter((event) => event.type === "run.usage")).toEqual([
      expect.objectContaining({
        modelCallId: "call-a",
        inputTokens: 10,
        outputTokens: 7,
        runInputTokens: 10,
        runOutputTokens: 7,
      }),
    ]);
  });

  it("缺失 SDK call ID 时拒绝计量，message ID 与 token 值不能替代调用身份", async () => {
    const chunk = new AIMessageChunk<StandardMessageStructure>({
      id: "message-id-is-not-a-call-id",
      content: "",
      usage_metadata: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    });
    const stream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield {
          event: "on_chat_model_start",
          metadata: { [MODEL_USAGE_OWNER_METADATA]: modelUsageOwner },
          data: { input: { messages: [] } },
        };
        yield { event: "on_chat_model_stream", data: { chunk } };
        yield { event: "on_chat_model_end", data: { output: chunk } };
      },
    };
    const seen: ModelCallUsage[] = [];
    const events = await collectUsage(stream, (usage) => {
      seen.push(usage);
    });
    expect(seen).toEqual([]);
    expect(events.filter((event) => event.type === "run.usage")).toEqual([]);
    expect(events.at(-1)?.type).toBe("run.completed");
  });
});

/**
 * 平均缓存命中率的口径：**跨模型调用累计**（按 token 加权）。
 *
 * 一轮里工具调用会让提示词逐次变大（input 100 → 900），各次命中率差异很大；
 * 客户端要拿「累计命中 ÷ 累计输入」才能算出正确的平均命中率，故服务端把累计值
 * 一并下发。这里用两次调用（100/90 与 900/0）锁住：runInputTokens=1000、
 * runCachedInputTokens=90（加权 9%），而不是两份单次读数的算术平均。
 */
describe("stream-adapter 累计用量（平均缓存命中率的分母）", () => {
  it("两次调用的累计值随最后一次 run.usage 下发", async () => {
    const stream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        // 第一次调用：同 call 的 stream/end 绝对值只应算一次
        yield* chunkStream("call-a", [
          usageChunk(100, 90, 1),
          usageChunk(100, 90, 1),
        ]);
        // 第二次调用：提示词变长（工具结果进了上下文），这次没命中缓存
        yield* chunkStream("call-b", [usageChunk(900, 0, 1)]);
      },
    };

    const events: StreamEvent[] = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conv-1",
      runId: "run-1",
      sessionId: "sess-1",
      stream,
    })) {
      events.push(event);
    }

    const usageEvents = events.filter((event) => event.type === "run.usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({
      modelCallId: "call-a",
      inputTokens: 100,
      runInputTokens: 100,
      runOutputTokens: 1,
      runCachedInputTokens: 90,
    });
    expect(usageEvents[1]).toMatchObject({
      modelCallId: "call-b",
      inputTokens: 900,
      runInputTokens: 1000,
      runOutputTokens: 2,
      runCachedInputTokens: 90,
    });
  });

  it("上游一次都没报缓存：不下发累计缓存字段（不拿 0 冒充）", async () => {
    const stream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield* chunkStream("call-a", [usageChunk(500, undefined, 1)]);
      },
    };
    const events: StreamEvent[] = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conv-1",
      runId: "run-1",
      sessionId: "sess-1",
      stream,
    })) {
      events.push(event);
    }
    const usage = events.find((event) => event.type === "run.usage");
    expect(usage).toMatchObject({ runInputTokens: 500 });
    expect(usage).not.toHaveProperty("runCachedInputTokens");
  });
});

/**
 * 分类占比随 run.usage 下发（R4-1 浮层那一栏）。
 *
 * 消息侧在 `on_chat_model_start` 量、工具侧由 runtime 传入，两边合并成一条
 * composition；**没有 on_chat_model_start（老上游/非 chat 模型）时不下发该字段**，
 * 而不是编一段空的。
 */
describe("stream-adapter 分类占比", () => {
  it("on_chat_model_start 的 messages + 传入的工具分段 → 合并后随 run.usage 下发", async () => {
    const stream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield {
          event: "on_chat_model_start",
          run_id: "call-a",
          metadata: { [MODEL_USAGE_OWNER_METADATA]: modelUsageOwner },
          data: {
            input: {
              messages: [
                [new SystemMessage("sys"), new HumanMessage("用户消息")],
              ],
            },
          },
        };
        const chunk = usageChunk(100, undefined, 1);
        yield {
          event: "on_chat_model_stream",
          run_id: "call-a",
          data: { chunk },
        };
        yield {
          event: "on_chat_model_end",
          run_id: "call-a",
          data: { output: chunk },
        };
      },
    };

    const events: StreamEvent[] = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conv-1",
      runId: "run-1",
      sessionId: "sess-1",
      stream,
      toolComposition: [{ label: "系统工具", chars: 300 }],
    })) {
      events.push(event);
    }

    const usage = events.find((event) => event.type === "run.usage");
    expect(usage).toMatchObject({
      composition: [
        { label: "系统工具", chars: 300 },
        { label: "消息", chars: "用户消息".length },
        { label: "系统提示词", chars: "sys".length },
      ],
    });
  });

  it("没有模型输入事件：不下发 composition（不编空段）", async () => {
    const stream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        const chunk = usageChunk(10, undefined, 1);
        yield {
          event: "on_chat_model_stream",
          run_id: "call-a",
          data: { chunk },
        };
        yield {
          event: "on_chat_model_end",
          run_id: "call-a",
          data: { output: chunk },
        };
      },
    };
    const events: StreamEvent[] = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conv-1",
      runId: "run-1",
      sessionId: "sess-1",
      stream,
      toolComposition: [{ label: "系统工具", chars: 300 }],
    })) {
      events.push(event);
    }
    const usage = events.find((event) => event.type === "run.usage");
    expect(usage).not.toHaveProperty("composition");
  });
});

/** 产品压缩信号只能消费已确认checkpoint的新摘要事实，旧模型输入marker不是发生凭据。 */
describe("stream-adapter 自动压缩信号", () => {
  const autoCompact = {
    trigger: { type: "tokens" as const, value: 872_000 },
    keep: { type: "messages" as const, value: 20 },
    source: "reserved-output" as const,
  };

  async function collectCompactionFacts(
    options: { autoCompact?: typeof autoCompact; committed?: boolean } = {},
  ) {
    const summary = new HumanMessage({
      content: "较早对话的摘要",
      additional_kwargs: { lc_source: "summarization" },
    });
    const stream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield {
          event: "on_chat_model_start",
          run_id: "call-a",
          metadata: { [MODEL_USAGE_OWNER_METADATA]: modelUsageOwner },
          data: { input: { messages: [[new SystemMessage("sys"), summary]] } },
        };
        if (options.committed) {
          yield {
            event: "on_custom_event",
            name: "kenfutwork.compaction.applied",
            data: { output: { checkpointId: "new-checkpoint" } },
          };
          yield {
            event: "on_custom_event",
            name: "kenfutwork.compaction.applied",
            data: { output: { checkpointId: "later-checkpoint" } },
          };
        }
        yield {
          event: "on_chat_model_start",
          run_id: "call-b",
          metadata: { [MODEL_USAGE_OWNER_METADATA]: modelUsageOwner },
          data: { input: { messages: [[new SystemMessage("sys"), summary]] } },
        };
      },
    };
    const events: StreamEvent[] = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conv-1",
      runId: "run-1",
      sessionId: "sess-1",
      stream,
      ...(options.autoCompact ? { autoCompact: options.autoCompact } : {}),
    }))
      events.push(event);
    return events;
  }

  it("已提交的新摘要事实发一次run.compacted，保留真实触发口径", async () => {
    const events = await collectCompactionFacts({
      autoCompact,
      committed: true,
    });
    expect(events.filter((event) => event.type === "run.compacted")).toEqual([
      expect.objectContaining({
        runId: "run-1",
        triggerTokens: 872_000,
        triggerSource: "reserved-output",
        keepMessages: 20,
      }),
    ]);
    expect(events.at(-1)?.type).toBe("run.completed");
  });
  it("重复看到既存摘要输入不会制造新压缩事件", async () => {
    const events = await collectCompactionFacts({ autoCompact });
    expect(events.filter((event) => event.type === "run.compacted")).toEqual(
      [],
    );
  });
  it("压缩口径未启用时，不能消费新摘要事实制造压缩提示", async () => {
    const events = await collectCompactionFacts({ committed: true });
    expect(events.filter((event) => event.type === "run.compacted")).toEqual(
      [],
    );
  });
});

describe("stream-adapter 子代理归因（DEC-19）", () => {
  function eventStream(events: unknown[]): AsyncIterable<unknown> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    };
  }

  it("父派发完成属于主会话，不继承自己派发出的子代理身份", async () => {
    const events = await collect(
      eventStream([
        {
          event: "on_tool_start",
          name: "subagent_task",
          run_id: "parent-dispatch",
          data: { input: { subagent_type: "explore" } },
        },
        {
          event: "on_tool_end",
          name: "subagent_task",
          run_id: "parent-dispatch",
          data: { output: "调研完成" },
        },
      ]),
      {},
    );
    const completed = events.find((event) => event.type === "tool.completed");

    expect(completed).not.toHaveProperty("agentCallId");
  });

  it("使用模型工具调用身份的公开事实，忽略 SDK 运行 id 产生的重复生命周期", async () => {
    const events = await collect(
      eventStream([
        {
          event: "on_custom_event",
          name: "kenfutwork.tool",
          data: {
            phase: "started",
            toolCallId: "model-call-1",
            toolName: "read_file",
            input: { path: "/a.ts" },
          },
        },
        {
          event: "on_tool_start",
          name: "read_file",
          run_id: "sdk-run-1",
          data: { input: { path: "/a.ts" } },
        },
        {
          event: "on_custom_event",
          name: "kenfutwork.tool",
          data: {
            phase: "completed",
            toolCallId: "model-call-1",
            toolName: "read_file",
            output: new ToolMessage({
              tool_call_id: "model-call-1",
              content: "文件正文",
            }),
          },
        },
        {
          event: "on_tool_end",
          name: "read_file",
          run_id: "sdk-run-1",
          data: { output: "文件正文" },
        },
      ]),
      { canonicalToolEvents: true },
    );

    expect(
      events
        .filter(
          (event) =>
            event.type === "tool.started" || event.type === "tool.completed",
        )
        .map((event) => event.toolCallId),
    ).toEqual(["model-call-1", "model-call-1"]);
  });

  it("子代理模型流打标下发（agentName/agentCallId），主 agent 文本不带标——前端据此路由进子代理视图", async () => {
    const events = await collect(
      eventStream([
        {
          event: "on_chat_model_stream",
          data: {
            chunk: new AIMessageChunk<StandardMessageStructure>({
              content: "主文",
            }),
          },
        },
        {
          event: "on_chat_model_stream",
          data: {
            chunk: new AIMessageChunk<StandardMessageStructure>({
              content: "子文",
            }),
          },
          metadata: {
            lc_agent_name: "explore",
            lc_agent_call_id: "parent-call-1",
          },
        },
      ]),
      {},
    );
    const deltas = events.filter((event) => event.type === "message.delta");
    expect(deltas).toHaveLength(2);
    // 主 agent 文本：无归因字段
    expect(deltas[0]).toMatchObject({ delta: "主文" });
    expect(deltas[0]).not.toHaveProperty("agentName");
    // 子代理文本：带归因与路由键（zcode 右栏模型）
    expect(deltas[1]).toMatchObject({
      delta: "子文",
      agentName: "explore",
      agentCallId: "parent-call-1",
    });
  });

  it("子代理的工具事件带 agentName；主 agent 工具事件不带", async () => {
    const events = await collect(
      eventStream([
        {
          event: "on_tool_start",
          name: "read_file",
          run_id: "child-1",
          data: { input: { path: "a.ts" } },
          metadata: { lc_agent_name: "explore" },
        },
        {
          event: "on_tool_end",
          name: "read_file",
          run_id: "child-1",
          data: { output: "文件内容" },
          metadata: { lc_agent_name: "explore" },
        },
        {
          event: "on_tool_start",
          name: "web_search",
          run_id: "main-1",
          data: { input: { query: "x" } },
        },
      ]),
      {},
    );
    const started = events.filter((event) => event.type === "tool.started");
    expect(started[0]).toMatchObject({
      toolName: "read_file",
      agentName: "explore",
    });
    expect(started[1]).toMatchObject({ toolName: "web_search" });
    expect(started[1]).not.toHaveProperty("agentName");
    const completed = events.filter((event) => event.type === "tool.completed");
    expect(completed[0]).toMatchObject({ agentName: "explore" });
  });
});

describe("stream-adapter 派发栈兜底归因（DEC-19：metadata 缺失时）", () => {
  function eventStream(events: unknown[]): AsyncIterable<unknown> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    };
  }

  it("子代理嵌套工具事件缺 metadata 时，按派发栈继承 agentName/agentCallId", async () => {
    const events = await collect(
      eventStream([
        // 父派发调用开始（subagent_task，input 带 subagent_type）
        {
          event: "on_tool_start",
          name: "subagent_task",
          run_id: "dispatch-1",
          data: { input: { subagent_type: "explore", description: "调研" } },
        },
        // 子代理嵌套工具事件：无 metadata（真机实测的传播缺口）
        {
          event: "on_tool_start",
          name: "read_file",
          run_id: "child-1",
          data: { input: { path: "a.ts" } },
        },
        {
          event: "on_tool_end",
          name: "read_file",
          run_id: "child-1",
          data: { output: "内容" },
        },
        // 派发完成 → 栈弹出到空
        {
          event: "on_tool_end",
          name: "subagent_task",
          run_id: "dispatch-1",
          data: { output: "调研结论" },
        },
        // 主 agent 后续工具：不应再带归因
        {
          event: "on_tool_start",
          name: "web_search",
          run_id: "main-2",
          data: { input: { query: "x" } },
        },
      ]),
      {},
    );
    const started = events.filter((event) => event.type === "tool.started");
    // [派发自身, 子代理 read_file, 主 agent web_search]
    expect(started).toHaveLength(3);
    expect(started[1]).toMatchObject({
      toolName: "read_file",
      agentName: "explore",
      agentCallId: "dispatch-1",
    });
    expect(started[2]).not.toHaveProperty("agentName");
    const completed = events.filter((event) => event.type === "tool.completed");
    expect(completed[0]).toMatchObject({
      toolName: "read_file",
      agentName: "explore",
    });
  });

  it("subagent_task 自身的派发行不带 agentName（父调用不是子代理内部事件）", async () => {
    const events = await collect(
      eventStream([
        {
          event: "on_tool_start",
          name: "subagent_task",
          run_id: "dispatch-2",
          data: { input: { subagent_type: "review" } },
        },
      ]),
      {},
    );
    const started = events.filter((event) => event.type === "tool.started");
    expect(started[0]).toMatchObject({ toolName: "subagent_task" });
    expect(started[0]).not.toHaveProperty("agentName");
  });
});
