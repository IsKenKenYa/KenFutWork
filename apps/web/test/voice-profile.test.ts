import { describe, expect, it } from "vitest";

import {
  ASR_RTF_EXCELLENT,
  ASR_RTF_GOOD,
  ASR_RTF_UNUSABLE,
  adviseVoiceProfile,
  gradeAsrRtf,
  gradeLlm,
  gradeTts,
  LLM_TOKENS_PER_SECOND_GOOD,
  LLM_TOKENS_PER_SECOND_MIN,
  LLM_TTFT_FAST_SECONDS,
  median,
  TTS_FIRST_BYTE_SECONDS,
  TTS_RTF_LIMIT,
} from "../src/lib/voice-profile.js";

/**
 * 阈值边界单测（规划 §6 / §10 风险 6：改阈值必须过单测）。
 * 每个阈值都测**两侧**（刚好达标 / 刚好不达标），只测一侧等于没锁。
 */

describe("gradeAsrRtf（听：≤0.5 优 / ≤1.0 良 / >2.0 差）", () => {
  it("阈值两侧：0.5 与 1.0 是「良」的上界，2.0 之上是差", () => {
    expect(gradeAsrRtf(ASR_RTF_EXCELLENT).grade).toBe("excellent");
    expect(gradeAsrRtf(ASR_RTF_EXCELLENT + 0.001).grade).toBe("good");
    expect(gradeAsrRtf(ASR_RTF_GOOD).grade).toBe("good");
    expect(gradeAsrRtf(ASR_RTF_GOOD + 0.001).grade).toBe("poor");
    expect(gradeAsrRtf(ASR_RTF_UNUSABLE).grade).toBe("poor");
    expect(gradeAsrRtf(ASR_RTF_UNUSABLE + 0.001).grade).toBe("unusable");
  });

  it("推荐档：优/良推荐，偏慢与太慢不推荐（但不等于禁用）", () => {
    expect(gradeAsrRtf(0.2).recommended).toBe(true);
    expect(gradeAsrRtf(0.9).recommended).toBe(true);
    expect(gradeAsrRtf(1.5).recommended).toBe(false);
    expect(gradeAsrRtf(5).recommended).toBe(false);
  });

  it("实测口径写进文案：1 倍速会说明「识别比说话更花时间」的意思", () => {
    expect(gradeAsrRtf(0.25).summary).toContain("4.0 倍速");
    expect(gradeAsrRtf(3).summary).toContain("太慢");
  });

  it("非法读数不猜：NaN / 负数一律判不可用", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(gradeAsrRtf(bad).grade).toBe("unusable");
      expect(gradeAsrRtf(bad).recommended).toBe(false);
    }
  });
});

describe("gradeLlm（想：TTFT ≤1.5s 且 ≥15 tok/s）", () => {
  it("两个条件都达标才推荐完整回路", () => {
    const ok = gradeLlm({
      ttftSeconds: LLM_TTFT_FAST_SECONDS,
      tokensPerSecond: LLM_TOKENS_PER_SECOND_GOOD,
    });
    expect(ok.recommended).toBe(true);

    // 首字刚好超一点：不推荐（语音回路里首字就是等待感）
    const slowFirst = gradeLlm({
      ttftSeconds: LLM_TTFT_FAST_SECONDS + 0.001,
      tokensPerSecond: 100,
    });
    expect(slowFirst.recommended).toBe(false);
    expect(slowFirst.usableWithCaution).toBe(true);

    // 速度刚好掉到 15 以下：进「可用但有提示」档
    const slightlySlow = gradeLlm({
      ttftSeconds: 0.3,
      tokensPerSecond: LLM_TOKENS_PER_SECOND_GOOD - 0.001,
    });
    expect(slightlySlow.recommended).toBe(false);
    expect(slightlySlow.usableWithCaution).toBe(true);
  });

  it("8 tok/s 是「可用但有提示」与「建议改在线」的分界", () => {
    expect(
      gradeLlm({ ttftSeconds: 0.3, tokensPerSecond: LLM_TOKENS_PER_SECOND_MIN })
        .summary,
    ).toContain("可用，但补一条需求要等几秒");
    expect(
      gradeLlm({
        ttftSeconds: 0.3,
        tokensPerSecond: LLM_TOKENS_PER_SECOND_MIN - 0.001,
      }).summary,
    ).toContain("建议「想」段改用在线模型");
  });

  it("远端端点不给速度读数：首字达标即推荐，且文案说明原因", () => {
    const remote = gradeLlm({ ttftSeconds: 0.4 });
    expect(remote.recommended).toBe(true);
    expect(remote.summary).toContain("未给出生成速度读数");

    // 首字不达标时，没有速度读数也不放行
    expect(gradeLlm({ ttftSeconds: 3 }).recommended).toBe(false);
  });

  it("非法读数不猜", () => {
    expect(gradeLlm({ ttftSeconds: Number.NaN }).recommended).toBe(false);
    expect(
      gradeLlm({ ttftSeconds: 0.2, tokensPerSecond: Number.NaN }).summary,
    ).toContain("未给出生成速度读数");
  });
});

describe("gradeTts（说：首包 ≤0.5s 且 RTF ≤1）", () => {
  it("两个条件都要满足", () => {
    expect(
      gradeTts({ firstByteSeconds: TTS_FIRST_BYTE_SECONDS, rtf: TTS_RTF_LIMIT })
        .recommended,
    ).toBe(true);
    expect(
      gradeTts({
        firstByteSeconds: TTS_FIRST_BYTE_SECONDS + 0.001,
        rtf: 0.2,
      }).recommended,
    ).toBe(false);
    expect(
      gradeTts({ firstByteSeconds: 0.1, rtf: TTS_RTF_LIMIT + 0.001 })
        .recommended,
    ).toBe(false);
  });

  it("非法读数不推荐并说明", () => {
    expect(
      gradeTts({ firstByteSeconds: Number.NaN, rtf: 1 }).summary,
    ).toContain("没有测得");
  });
});

describe("adviseVoiceProfile（一键应用推荐的判定）", () => {
  const fastAsr = gradeAsrRtf(0.2);
  const fastLlm = gradeLlm({ ttftSeconds: 0.4, tokensPerSecond: 30 });
  const slowLlm = gradeLlm({ ttftSeconds: 4 });
  const goodTts = gradeTts({ firstByteSeconds: 0.2, rtf: 0.5 });

  it("听说都快 → 推荐完整回路；说也不慢 → 推荐语音播报", () => {
    const advice = adviseVoiceProfile({
      asr: fastAsr,
      llm: fastLlm,
      tts: goodTts,
    });
    expect(advice.recommendedMode).toBe("loop");
    expect(advice.recommendedSpeakReplies).toBe(true);
    expect(advice.reasons.length).toBeGreaterThan(0);
  });

  it("任一段不达标就退回「只转文本」，并说明是哪一段拖后腿", () => {
    const advice = adviseVoiceProfile({ asr: fastAsr, llm: slowLlm });
    expect(advice.recommendedMode).toBe("transcribe");
    expect(advice.reasons.some((line) => line.includes("「想」"))).toBe(true);
    // 没测「说」就不推荐播报
    expect(advice.recommendedSpeakReplies).toBe(false);
  });

  it("完全没有数据：仍给可用的默认结论（只转文本），不给空白页", () => {
    const advice = adviseVoiceProfile({});
    expect(advice.recommendedMode).toBe("transcribe");
    expect(advice.recommendedSpeakReplies).toBe(false);
    expect(advice.reasons[0]).toContain("先用默认的「只转文本」");
  });

  it("听不达标但想很快：也退回只转文本（听是入口）", () => {
    const advice = adviseVoiceProfile({ asr: gradeAsrRtf(3), llm: fastLlm });
    expect(advice.recommendedMode).toBe("transcribe");
    expect(advice.reasons.some((line) => line.includes("「听」"))).toBe(true);
  });
});

describe("median（真实使用耗时的中位数）", () => {
  it("奇偶长度都对；空数组回 undefined 而不是 NaN", () => {
    expect(median([])).toBeUndefined();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("不篡改入参（内部排序用副本）", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});
