import { describe, expect, it } from "vitest";

import { createVoiceTimingLog } from "./timing-log.js";

/**
 * 实测耗时记录的统计口径。核心是**首次调用单列**：实测同一台机器上首次调用的
 * RTF 是稳态的 8~9 倍（差在两百兆模型载入，实测 0.68 vs 0.08），
 * 混进中位数会把快机器报成慢机器。
 */
describe("timing-log（只记耗时，不记音频与文本）", () => {
  it("空日志：没有中位数、样本数为 0（不给 0 当读数）", () => {
    const log = createVoiceTimingLog();
    const summary = log.summary();
    expect(summary.samples).toBe(0);
    expect(summary.rtfMedian).toBeUndefined();
    expect(summary.modelLoadMs).toBeUndefined();
  });

  it("首次调用只记载入耗时，不进中位 RTF", () => {
    const log = createVoiceTimingLog();
    // 首次：4 秒音频用 2.7 秒（含模型载入）→ 不许进统计
    log.record({ clipSeconds: 4, elapsedMs: 2_700, cold: true });
    const summary = log.summary();
    expect(summary.samples).toBe(0);
    expect(summary.rtfMedian).toBeUndefined();
    expect(summary.modelLoadMs).toBe(2_700);

    // 稳态：4 秒音频用 0.32 秒
    log.record({ clipSeconds: 4, elapsedMs: 320, cold: false });
    const warm = log.summary();
    expect(warm.samples).toBe(1);
    expect(warm.rtfMedian).toBeCloseTo(0.08, 3);
    // 载入耗时不因稳态样本出现而丢失
    expect(warm.modelLoadMs).toBe(2_700);
  });

  it("中位数：奇偶长度、以及不同音频时长按实时率（而非耗时）归一", () => {
    const log = createVoiceTimingLog();
    // 1 秒音频 100ms（RTF 0.1）、4 秒音频 800ms（RTF 0.2）——按 RTF 中位应为 0.15
    log.record({ clipSeconds: 1, elapsedMs: 100, cold: false });
    log.record({ clipSeconds: 4, elapsedMs: 800, cold: false });
    expect(log.summary().rtfMedian).toBeCloseTo(0.15, 6);

    log.record({ clipSeconds: 1, elapsedMs: 500, cold: false });
    // 三个 RTF：0.1 / 0.2 / 0.5 → 中位 0.2
    expect(log.summary().rtfMedian).toBeCloseTo(0.2, 6);
  });

  it("滑动窗只留最近 50 次（内存不随使用时长涨）", () => {
    const log = createVoiceTimingLog();
    for (let i = 0; i < 80; i += 1) {
      log.record({ clipSeconds: 1, elapsedMs: 100 + i, cold: false });
    }
    const summary = log.summary();
    expect(summary.samples).toBe(50);
    // 窗口内最大 RTF 对应 i=79（179ms），最小 i=30（130ms）→ 中位约 0.1545
    expect(summary.rtfMedian).toBeGreaterThan(0.15);
    expect(summary.rtfMedian).toBeLessThan(0.16);
  });

  it("非法读数直接丢弃（NaN/负数/零时长不污染统计）", () => {
    const log = createVoiceTimingLog();
    log.record({ clipSeconds: 0, elapsedMs: 100, cold: false });
    log.record({ clipSeconds: Number.NaN, elapsedMs: 100, cold: false });
    log.record({ clipSeconds: 2, elapsedMs: Number.NaN, cold: false });
    log.record({ clipSeconds: 2, elapsedMs: -5, cold: false });
    expect(log.summary().samples).toBe(0);
    expect(log.summary().lastClipSeconds).toBeUndefined();
  });

  it("lastClipSeconds 记住最近一次音频时长（核对统计口径用）", () => {
    const log = createVoiceTimingLog();
    log.record({ clipSeconds: 1.5, elapsedMs: 100, cold: false });
    log.record({ clipSeconds: 3.25, elapsedMs: 100, cold: false });
    expect(log.summary().lastClipSeconds).toBe(3.25);
  });

  it("reset 清空（「重新检测」用）", () => {
    const log = createVoiceTimingLog();
    log.record({ clipSeconds: 2, elapsedMs: 200, cold: true });
    log.record({ clipSeconds: 2, elapsedMs: 200, cold: false });
    log.reset();
    expect(log.summary()).toEqual({ samples: 0 });
  });
});
