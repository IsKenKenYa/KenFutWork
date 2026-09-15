import type { StreamEvent } from "@loomic/shared";
import { describe, expect, it } from "vitest";

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
            return Promise.resolve({ done: false, value: undefined });
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
