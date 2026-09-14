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
