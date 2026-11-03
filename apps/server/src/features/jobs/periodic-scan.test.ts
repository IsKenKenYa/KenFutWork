import { afterEach, describe, expect, it, vi } from "vitest";
import { startPeriodicScan } from "./periodic-scan.js";

describe("进程内周期扫描", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("按间隔触发；上一轮未结束时跳过本次", async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const scan = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const stop = startPeriodicScan({ scan, intervalMs: 60_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("单轮失败交给 onError，下一轮继续", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const scan = vi
      .fn()
      .mockRejectedValueOnce(new Error("读取失败"))
      .mockResolvedValue(undefined);
    const stop = startPeriodicScan({
      scan,
      intervalMs: 60_000,
      onError: (error) => errors.push(error),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);

    stop();
  });
});
