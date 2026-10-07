import { describe, expect, it } from "vitest";

import {
  buildReport,
  listenSegment,
  speakSegment,
  thinkSegment,
} from "./diagnose.js";

/**
 * 检测结论的三态口径（规划 §6 的硬规则）：性能不足只是警告，
 * **只有硬缺失才置灰**；置灰必须写明为什么（不摆空壳）。
 */
const HARDWARE = {
  cpuModel: "Test CPU",
  cpuCores: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  platform: "win32 10.0",
};

describe("listenSegment（听：用真实使用的实测）", () => {
  it("有稳态样本：给中位实时率与首次载入耗时", () => {
    const segment = listenSegment({
      rtfMedian: 0.083,
      samples: 12,
      modelLoadMs: 2_700,
      lastClipSeconds: 3.2,
    });
    expect(segment.state).toBe("measured");
    // 只给数字与「首载」标注，不写句子（界面文案硬约束）
    expect(segment.summary).toBe("0.08× 首载 2.7s");
    expect(segment.listen).toEqual({
      samples: 12,
      rtfMedian: 0.083,
      modelLoadMs: 2_700,
      lastClipSeconds: 3.2,
    });
  });

  it("还没说过话：pending + 一句怎么拿到读数的引导（不是空白，也不是假数字）", () => {
    const segment = listenSegment({ samples: 0 });
    expect(segment.state).toBe("pending");
    expect(segment.summary).toBe("未实测（说一句即可）");
    expect(segment.listen?.rtfMedian).toBeUndefined();
    // 首次载入耗时即便还没稳态样本，也已经能报（用户感知得到的那段等待）
    const withCold = listenSegment({ samples: 0, modelLoadMs: 2_700 });
    expect(withCold.listen?.modelLoadMs).toBe(2_700);
  });

  it("硬缺失（未选模型/未下载/运行时不可用）：unavailable 且原因是可读中文", () => {
    const segment = listenSegment(
      { samples: 0 },
      "「听」模型文件缺失：C:\\x\\model.onnx",
    );
    expect(segment.state).toBe("unavailable");
    expect(segment.summary).toContain("model.onnx");
    // 置灰时不带读数，免得界面同时显示「不可用」与一个数字
    expect(segment.listen).toBeUndefined();
  });

  it("summary 只给数字（不写成句子）", () => {
    const summary = listenSegment({ rtfMedian: 0.5, samples: 3 }).summary;
    expect(summary).toBe("0.50×");
    // 句子特征（含「，」或「。」）不允许出现在界面读数里
    expect(summary).not.toMatch(/[，。]/);
  });
});

describe("thinkSegment（想：首 token 延迟）", () => {
  it("有读数：报首字与（可选）生成速度", () => {
    const segment = thinkSegment({ ttftSeconds: 0.42, tokensPerSecond: 32.5 });
    expect(segment.state).toBe("measured");
    expect(segment.summary).toBe("0.42s 33t/s");
    expect(segment.think).toEqual({ ttftSeconds: 0.42, tokensPerSecond: 32.5 });
  });

  it("端点不给速度读数：只说首字（不编一个速度出来）", () => {
    const segment = thinkSegment({ ttftSeconds: 0.9 });
    expect(segment.summary).toBe("0.90s");
    expect(segment.think?.tokensPerSecond).toBeUndefined();
  });

  it("未选/探测失败：unavailable + 原因；没探过则 pending", () => {
    expect(
      thinkSegment(undefined, "未选择「想」模型：完整回路需要一个对话模型。")
        .state,
    ).toBe("unavailable");
    expect(
      thinkSegment(undefined, "「想」段探测失败：HTTP 401").summary,
    ).toContain("HTTP 401");
    expect(thinkSegment(undefined).state).toBe("pending");
  });
});

describe("speakSegment（说：首包 + 实时率）", () => {
  it("有实测：报首包与实时率（规划 §6 的门限就靠这两个数）", () => {
    const segment = speakSegment({ firstByteSeconds: 0.42, rtf: 0.28 });
    expect(segment.state).toBe("measured");
    expect(segment.summary).toBe("首包 0.42s、实时率 0.28");
  });

  it("没测过：pending 并说明点一下就现场合成（不是空白，也不是假读数）", () => {
    const segment = speakSegment();
    expect(segment.state).toBe("pending");
    expect(segment.summary).toBe("未实测（点重新检测）");
  });

  it("硬缺失（未选模型/合成失败）：unavailable + 原因是「为什么」", () => {
    const segment = speakSegment(
      undefined,
      "未选择「说」模型：到「设置 → 语音」选一个。",
    );
    expect(segment.state).toBe("unavailable");
    expect(segment.summary).toContain("未选择「说」模型");
  });
});

describe("buildReport", () => {
  it("形状完整（硬件 + 三段 + 时间戳），可被契约解析", () => {
    const report = buildReport({
      hardware: HARDWARE,
      listen: listenSegment({ samples: 0 }),
      think: thinkSegment(undefined),
      speak: speakSegment(),
      measuredAt: new Date("2026-09-26T10:00:00.000Z"),
    });
    expect(report.measuredAt).toBe("2026-09-26T10:00:00.000Z");
    expect(report.hardware).toEqual(HARDWARE);
    expect(Object.keys(report).sort()).toEqual([
      "hardware",
      "listen",
      "measuredAt",
      "speak",
      "think",
    ]);
  });
});
