import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "@kenfutwork/shared";
import { createStreamingEventFlusher } from "./stream-flush.js";

function delta(
  text: string,
  overrides: Partial<Extract<StreamEvent, { type: "message.delta" }>> = {},
): Extract<StreamEvent, { type: "message.delta" }> {
  return {
    type: "message.delta",
    runId: "run-1",
    messageId: "message-1",
    delta: text,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

interface FlusherFixture {
  sink: (event: StreamEvent) => Promise<void>;
  flushed: StreamEvent[];
  handle(event: StreamEvent): Promise<void>;
  flush(): Promise<void>;
}

function fixture(flushIntervalMs = 80): FlusherFixture {
  const flushed: StreamEvent[] = [];
  const flusher = createStreamingEventFlusher({
    flushIntervalMs,
    sink: async (event) => {
      flushed.push(event);
    },
  });
  return {
    flushed,
    handle: (event) => flusher.handle(event),
    flush: () => flusher.flush(),
    sink: () => Promise.resolve(),
  };
}

describe("createStreamingEventFlusher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("同 key 连续 delta 按刷新间隔合并为一条", async () => {
    const f = fixture();
    await f.handle(delta("你好"));
    await f.handle(delta("，世界"));
    await f.handle(delta("！"));
    // 刷新前缓冲不落地：工具与终态事件之外的推送节奏由间隔决定。
    expect(f.flushed).toEqual([]);
    await vi.advanceTimersByTimeAsync(80);
    expect(f.flushed).toHaveLength(1);
    expect(f.flushed[0]).toMatchObject({ type: "message.delta", delta: "你好，世界！" });
  });

  it("不同 key 的 delta 到来先落地旧缓冲，保持输入顺序", async () => {
    const f = fixture();
    await f.handle(delta("甲", { messageId: "m-a" }));
    await f.handle(delta("乙", { messageId: "m-b" }));
    expect(f.flushed).toHaveLength(1);
    expect(f.flushed[0]).toMatchObject({ messageId: "m-a", delta: "甲" });
    await vi.advanceTimersByTimeAsync(80);
    expect(f.flushed).toHaveLength(2);
    expect(f.flushed[1]).toMatchObject({ messageId: "m-b", delta: "乙" });
  });

  it("message.delta 与 thinking.delta 属不同 key，不互相拼接", async () => {
    const f = fixture();
    await f.handle(delta("正文", { messageId: "m-1" }));
    await f.handle({
      type: "thinking.delta",
      runId: "run-1",
      messageId: "m-1",
      delta: "思考",
      timestamp: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(80);
    expect(f.flushed.map((event) => event.type)).toEqual([
      "message.delta",
      "thinking.delta",
    ]);
  });

  it("非 delta 事件透传前先落地缓冲，顺序与输入一致", async () => {
    const f = fixture();
    await f.handle(delta("第一段"));
    await f.handle(delta("第二段"));
    const tool: StreamEvent = {
      type: "tool.started",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Read",
      timestamp: new Date().toISOString(),
    };
    await f.handle(tool);
    expect(f.flushed).toEqual([expect.objectContaining({ delta: "第一段第二段" }), tool]);
    await vi.advanceTimersByTimeAsync(80);
    expect(f.flushed).toHaveLength(2);
  });

  it("run.completed 透传前 flush，终态不会排到文本之前", async () => {
    const f = fixture();
    await f.handle(delta("结论"));
    const terminal: StreamEvent = {
      type: "run.completed",
      runId: "run-1",
      timestamp: new Date().toISOString(),
    };
    await f.handle(terminal);
    expect(f.flushed).toEqual([expect.objectContaining({ delta: "结论" }), terminal]);
  });

  it("flush 幂等：空缓冲时是 no-op，多次调用只落地一次", async () => {
    const f = fixture();
    await f.handle(delta("内容"));
    await f.flush();
    await f.flush();
    expect(f.flushed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(80);
    expect(f.flushed).toHaveLength(1);
  });

  it("定时器只按缓冲窗口节奏触发，长流不会每 chunk 一次", async () => {
    const f = fixture();
    for (let index = 0; index < 1000; index += 1) {
      await f.handle(delta(`片段${index}。`));
      await vi.advanceTimersByTimeAsync(8);
    }
    await f.flush();
    // 1000 个 chunk 跨 8s 虚拟时间，80ms 刷新间隔下至多 ~100 次落地（5 倍+ 削减）。
    expect(f.flushed.length).toBeGreaterThan(50);
    expect(f.flushed.length).toBeLessThanOrEqual(120);
    const joined = f.flushed
      .map((event) => (event.type === "message.delta" ? event.delta : ""))
      .join("");
    expect(joined).toBe(
      Array.from({ length: 1000 }, (_, index) => `片段${index}。`).join(""),
    );
  });

  it("合批流与逐条流在追加消费方终态一致", async () => {
    const chunks = Array.from({ length: 50 }, (_, index) => `第${index}句。`);
    const applyDeltas = (events: StreamEvent[]): string => {
      let text = "";
      for (const event of events) {
        if (event.type === "message.delta") text += event.delta;
      }
      return text;
    };
    const perEventText = applyDeltas(chunks.map((text) => delta(text)));
    const f = fixture();
    for (const text of chunks) {
      await f.handle(delta(text));
      await vi.advanceTimersByTimeAsync(20);
    }
    await f.flush();
    expect(applyDeltas(f.flushed)).toBe(perEventText);
  });

  it("子代理打标 delta 按 agentCallId 分 key，不串流", async () => {
    const f = fixture();
    await f.handle(delta("主", { messageId: "m-1" }));
    await f.handle(
      delta("子", {
        messageId: "m-2",
        agentName: "explore",
        agentCallId: randomUUID(),
      }),
    );
    await vi.advanceTimersByTimeAsync(80);
    expect(f.flushed).toHaveLength(2);
    expect(f.flushed[0]).toMatchObject({ delta: "主" });
    expect(f.flushed[1]).toMatchObject({ delta: "子", agentName: "explore" });
  });

  it("sink 失败随该次 handle/flush 冒出，且不阻断后续事件处理", async () => {
    const flushed: StreamEvent[] = [];
    const flusher = createStreamingEventFlusher({
      flushIntervalMs: 80,
      sink: async (event) => {
        if (event.type === "message.delta" && event.delta.includes("坏")) {
          throw new Error("落库失败");
        }
        flushed.push(event);
      },
    });
    await flusher.handle(delta("坏"));
    await expect(flusher.flush()).rejects.toThrow("落库失败");
    await flusher.handle(delta("好"));
    await vi.advanceTimersByTimeAsync(80);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ delta: "好" });
  });
});
