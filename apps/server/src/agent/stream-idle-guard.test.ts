import { describe, expect, it, vi } from "vitest";

import {
  StreamIdleTimeoutError,
  withStreamIdleGuard,
} from "./stream-idle-guard.js";

/** 可控流：手动决定何时产出下一个事件（模拟上游停滞）。 */
function controllableStream<T>() {
  const pending: Array<(value: IteratorResult<T>) => void> = [];
  const queue: T[] = [];
  let closed = false;
  let returnCalled = false;

  const stream: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            return Promise.resolve({ done: false, value: queue.shift() as T });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined as never });
          }
          return new Promise((resolve) => pending.push(resolve));
        },
        return(): Promise<IteratorResult<T>> {
          returnCalled = true;
          return Promise.resolve({ done: true, value: undefined as never });
        },
      };
    },
  };

  return {
    stream,
    push(value: T) {
      const resolve = pending.shift();
      if (resolve) {
        resolve({ done: false, value });
      } else {
        queue.push(value);
      }
    },
    close() {
      closed = true;
      for (const resolve of pending.splice(0)) {
        resolve({ done: true, value: undefined as never });
      }
    },
    didCallReturn: () => returnCalled,
  };
}

async function collect<T>(iterable: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

/**
 * 回归（GUI 实测事故）：上游首 token 后停滞时，消费侧 `for await` 曾永久阻塞，
 * run 卡 running 数分钟且中止信号不生效（只在下一个事件到达时才检查）。
 * 看门狗要求：停滞即有界失败；中止在等待期立即生效。
 */
describe("stream idle 看门狗", () => {
  it("正常流原样透传，不触发超时", async () => {
    const source = controllableStream<string>();
    const guarded = withStreamIdleGuard(source.stream, { idleMs: 1000 });
    const consuming = collect(guarded);
    source.push("a");
    source.push("b");
    source.close();
    expect(await consuming).toEqual(["a", "b"]);
  });

  it("停滞超过阈值即抛 StreamIdleTimeoutError 并中止底层请求", async () => {
    const source = controllableStream<string>();
    const onIdle = vi.fn();
    const guarded = withStreamIdleGuard(source.stream, {
      idleMs: 30,
      onIdle,
    });
    const result = collect(guarded);

    await expect(result).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(onIdle).toHaveBeenCalledTimes(1);
    // 提前退出时释放上游迭代器
    expect(source.didCallReturn()).toBe(true);
  });

  it("超时错误带面向用户文案（exposeToClient）", async () => {
    const source = controllableStream<string>();
    const guarded = withStreamIdleGuard(source.stream, { idleMs: 20 });
    const error = await collect(guarded).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect((error as StreamIdleTimeoutError).exposeToClient).toBe(true);
    expect((error as StreamIdleTimeoutError).message).toContain("没有任何输出");
  });

  it("等待期内的中止立即结束迭代（不等超时），由调用方据 signal 判取消", async () => {
    const source = controllableStream<string>();
    const controller = new AbortController();
    const guarded = withStreamIdleGuard(source.stream, {
      idleMs: 10_000,
      signal: controller.signal,
    });
    const consuming = collect(guarded);

    setTimeout(() => controller.abort(), 20);
    const startedAt = Date.now();
    expect(await consuming).toEqual([]);
    // 远早于 10s 空闲阈值返回
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(controller.signal.aborted).toBe(true);
  });

  it("事件产出后重置空闲计时（持续活跃的流不会被误杀）", async () => {
    const source = controllableStream<string>();
    const guarded = withStreamIdleGuard(source.stream, { idleMs: 60 });
    const received: string[] = [];
    const consuming = (async () => {
      for await (const item of guarded) {
        received.push(item);
      }
    })();

    // 每 20ms 推一个事件，累计时长超过单次阈值 3 倍
    for (let i = 0; i < 6; i += 1) {
      source.push(`tick-${i}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    source.close();
    await consuming;
    expect(received).toEqual([
      "tick-0",
      "tick-1",
      "tick-2",
      "tick-3",
      "tick-4",
      "tick-5",
    ]);
  });

  it("idleMs <= 0 表示不启用超时（长静默不报错）", async () => {
    const source = controllableStream<string>();
    const guarded = withStreamIdleGuard(source.stream, { idleMs: 0 });
    const consuming = collect(guarded);
    await new Promise((r) => setTimeout(r, 80));
    source.push("late");
    source.close();
    expect(await consuming).toEqual(["late"]);
  });
});

describe("停滞与取消并存的语义（真实接线：同一信号既作取消又由 onIdle 中止）", () => {
  it("停滞触发时即使信号随之被中止，仍报「停滞」而非「取消」", async () => {
    const source = controllableStream<string>();
    const controller = new AbortController();
    const guarded = withStreamIdleGuard(source.stream, {
      idleMs: 30,
      signal: controller.signal,
      // 运行时的真实接线：空闲超时即中止同一信号
      onIdle: () => controller.abort(),
    });

    const error = await collect(guarded).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect(controller.signal.aborted).toBe(true);
  });
});
