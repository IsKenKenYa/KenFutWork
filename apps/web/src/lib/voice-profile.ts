/**
 * 性能检测的判定口径（《语音助手插件规划》§6）。
 *
 * 纯函数 + 测试锁死阈值：阈值是产品口径（「这台机器值不值得开完整回路」），
 * 不是实现细节，改它必须过单测（规划 §10 风险 6）。
 *
 * 与 `workbench-surface.ts` / `work-directory.ts` 同样的「纯逻辑 + 测试钉死」形状。
 */

/** 听（ASR）的实时率档位：RTF = 处理耗时 / 音频时长。 */
export type VoiceRtfGrade = "excellent" | "good" | "poor" | "unusable";

/** ASR 阈值（规划 §6）：≤ 0.5 优 / ≤ 1.0 良 / > 2.0 差。 */
export const ASR_RTF_EXCELLENT = 0.5;
export const ASR_RTF_GOOD = 1;
export const ASR_RTF_UNUSABLE = 2;

export interface VoiceAsrVerdict {
  grade: VoiceRtfGrade;
  /** 给人看的一句话（含实测数字）。 */
  summary: string;
  /** 是否推荐用这条链路（不推荐 ≠ 禁用：规划 §6「检测不删功能」）。 */
  recommended: boolean;
}

export function gradeAsrRtf(rtf: number): VoiceAsrVerdict {
  if (!Number.isFinite(rtf) || rtf < 0) {
    return {
      grade: "unusable",
      summary: "没有测得有效的实时率。",
      recommended: false,
    };
  }
  const shown = `实时率 ${rtf.toFixed(2)}`;
  if (rtf <= ASR_RTF_EXCELLENT) {
    return {
      grade: "excellent",
      summary: `${shown}，识别很快（约 ${(1 / rtf).toFixed(1)} 倍速）。`,
      recommended: true,
    };
  }
  if (rtf <= ASR_RTF_GOOD) {
    return {
      grade: "good",
      summary: `${shown}，可用（说话时长与识别耗时大致相当）。`,
      recommended: true,
    };
  }
  if (rtf <= ASR_RTF_UNUSABLE) {
    return {
      grade: "poor",
      summary: `${shown}，偏慢（识别比说话更花时间）。`,
      recommended: false,
    };
  }
  return {
    grade: "unusable",
    summary: `${shown}，太慢：CPU 上很难等得住，建议换更小的模型或接 GPU/云端端点。`,
    recommended: false,
  };
}

/** 想（LLM）阈值（规划 §6）：TTFT ≤ 1.5s 且 ≥ 15 tok/s 推荐完整回路。 */
export const LLM_TTFT_FAST_SECONDS = 1.5;
export const LLM_TOKENS_PER_SECOND_GOOD = 15;
export const LLM_TOKENS_PER_SECOND_MIN = 8;

export interface VoiceLlmVerdict {
  /** 是否推荐用完整回路（方案 B）。 */
  recommended: boolean;
  /** 是否只够「可用但有提示」那档。 */
  usableWithCaution: boolean;
  summary: string;
}

export interface VoiceLlmMeasurement {
  /** 首 token 延迟（秒）；**在线链路真正在意的就是它**。 */
  ttftSeconds: number;
  /** 生成速度（token/秒）；远端端点可能给不出读数。 */
  tokensPerSecond?: number;
}

export function gradeLlm(measurement: VoiceLlmMeasurement): VoiceLlmVerdict {
  const { ttftSeconds, tokensPerSecond } = measurement;
  if (!Number.isFinite(ttftSeconds) || ttftSeconds < 0) {
    return {
      recommended: false,
      usableWithCaution: false,
      summary: "没有测得有效的首 token 延迟。",
    };
  }
  const ttft = `首字 ${ttftSeconds.toFixed(2)}s`;
  const speed =
    tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond)
      ? null
      : `${tokensPerSecond.toFixed(1)} tok/s`;

  // 首字慢：语音回路「说完要等多久才有回应」全靠它，慢就不是推荐档
  if (ttftSeconds > LLM_TTFT_FAST_SECONDS) {
    return {
      recommended: false,
      usableWithCaution: true,
      summary: `${ttft}${speed ? `、${speed}` : ""}：首字偏慢，语音回路的等待感明显，可先用「只转文本」。`,
    };
  }
  if (speed === null) {
    // 远端端点不给读数：首字达标就按推荐档（速度无从判定，不硬扣分）
    return {
      recommended: true,
      usableWithCaution: false,
      summary: `${ttft}：够快，推荐完整回路（端点未给出生成速度读数）。`,
    };
  }
  const value = tokensPerSecond as number;
  if (value >= LLM_TOKENS_PER_SECOND_GOOD) {
    return {
      recommended: true,
      usableWithCaution: false,
      summary: `${ttft}、${speed}：推荐完整回路。`,
    };
  }
  if (value >= LLM_TOKENS_PER_SECOND_MIN) {
    return {
      recommended: false,
      usableWithCaution: true,
      summary: `${ttft}、${speed}：可用，但补一条需求要等几秒。`,
    };
  }
  return {
    recommended: false,
    usableWithCaution: true,
    summary: `${ttft}、${speed}：生成偏慢，建议「想」段改用在线模型。`,
  };
}

/** 说（TTS）阈值（规划 §6）：首包 ≤ 0.5s 且 RTF ≤ 1 才推荐语音回复。 */
export const TTS_FIRST_BYTE_SECONDS = 0.5;
export const TTS_RTF_LIMIT = 1;

export interface VoiceTtsVerdict {
  recommended: boolean;
  summary: string;
}

export function gradeTts(measurement: {
  firstByteSeconds: number;
  rtf: number;
}): VoiceTtsVerdict {
  const { firstByteSeconds, rtf } = measurement;
  if (!Number.isFinite(firstByteSeconds) || !Number.isFinite(rtf)) {
    return { recommended: false, summary: "没有测得有效的合成耗时。" };
  }
  const shown = `首包 ${firstByteSeconds.toFixed(2)}s、实时率 ${rtf.toFixed(2)}`;
  const ok = firstByteSeconds <= TTS_FIRST_BYTE_SECONDS && rtf <= TTS_RTF_LIMIT;
  return ok
    ? { recommended: true, summary: `${shown}：推荐语音播报。` }
    : {
        recommended: false,
        summary: `${shown}：播报会有明显等待，建议关掉语音回复。`,
      };
}

/** 三段合起来的总体建议（设置页「一键应用推荐」的判定依据）。 */
export interface VoiceProfileAdvice {
  /** 推荐的功能模式：够快到哪一档就用哪一档。 */
  recommendedMode: "transcribe" | "loop";
  /** 是否推荐语音播报。 */
  recommendedSpeakReplies: boolean;
  reasons: string[];
}

export function adviseVoiceProfile(input: {
  asr?: VoiceAsrVerdict;
  llm?: VoiceLlmVerdict;
  tts?: VoiceTtsVerdict;
}): VoiceProfileAdvice {
  const reasons: string[] = [];
  const loopOk =
    input.asr?.recommended === true && input.llm?.recommended === true;
  if (input.asr) {
    reasons.push(input.asr.summary);
  }
  if (input.llm) {
    reasons.push(input.llm.summary);
  }
  if (input.tts) {
    reasons.push(input.tts.summary);
  }
  if (!loopOk) {
    reasons.push(
      input.asr?.recommended === false
        ? "「听」这条链路不够快，先只用「只转文本」。"
        : input.llm?.recommended === false
          ? "「想」这条链路不够快，先只用「只转文本」。"
          : "还没有足够实测数据，先用默认的「只转文本」。",
    );
  }
  return {
    recommendedMode: loopOk ? "loop" : "transcribe",
    recommendedSpeakReplies: input.tts?.recommended === true,
    reasons,
  };
}

/** 中位数（检测页显示真实使用中的实测耗时用；空数组回 undefined）。 */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) {
    return sorted[middle];
  }
  return (left + right) / 2;
}
