/**
 * 真实使用的转写耗时记录（规划 §6「运行期每轮语音的实测耗时汇总成中位数」）。
 *
 * 两条硬口径：
 * 1. **只记耗时**：不记音频、不记文本（规划 §8「通话记录留存」明确不做）。
 * 2. **首次调用单列**：实测发现同一台机器上「首次调用」的 RTF 是稳态的 8~9 倍
 *    ——差在两百兆模型的载入。把它混进中位数会把快机器报成慢机器，
 *    所以首次只记 `modelLoadMs`（用户能感知的是「第一次要等几秒」），
 *    中位 RTF 只由稳态调用构成。
 */

/** 参与统计的最近 N 次调用（内存环形窗；重启即清空，不需要持久化）。 */
const WINDOW_SIZE = 50;

export interface VoiceListenSample {
  /** 这段音频多长（秒）。 */
  clipSeconds: number;
  /** 处理耗时（毫秒）。 */
  elapsedMs: number;
  /** 该 provider 的首次调用（含模型载入）。 */
  cold: boolean;
}

export interface VoiceListenSummary {
  /** 稳态中位实时率（无稳态样本时缺席）。 */
  rtfMedian?: number;
  /** 参与中位数统计的稳态样本数。 */
  samples: number;
  /** 首次调用耗时（含模型载入，毫秒）；未发生过首次调用时缺席。 */
  modelLoadMs?: number;
  /** 最近一次音频时长（秒），供核对统计口径。 */
  lastClipSeconds?: number;
}

export interface VoiceTimingLog {
  record(sample: VoiceListenSample): void;
  /** 汇总（检测报告用）。 */
  summary(): VoiceListenSummary;
  /** 测试与「重新检测」用：清空窗口。 */
  reset(): void;
}

export function createVoiceTimingLog(): VoiceTimingLog {
  let coldMs: number | undefined;
  /** 稳态样本（环形窗，只保留最近 WINDOW_SIZE 条）。 */
  const warm: Array<{ clipSeconds: number; elapsedMs: number }> = [];
  let lastClipSeconds: number | undefined;

  return {
    record(sample) {
      if (!Number.isFinite(sample.clipSeconds) || sample.clipSeconds <= 0) {
        return;
      }
      if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0) {
        return;
      }
      lastClipSeconds = sample.clipSeconds;
      if (sample.cold) {
        coldMs = sample.elapsedMs;
        return;
      }
      warm.push({
        clipSeconds: sample.clipSeconds,
        elapsedMs: sample.elapsedMs,
      });
      if (warm.length > WINDOW_SIZE) {
        warm.splice(0, warm.length - WINDOW_SIZE);
      }
    },

    summary() {
      const rtfs = warm
        .map((entry) => entry.elapsedMs / 1000 / entry.clipSeconds)
        .filter((rtf) => Number.isFinite(rtf));
      return {
        ...(rtfs.length > 0 ? { rtfMedian: median(rtfs) } : {}),
        samples: rtfs.length,
        ...(coldMs === undefined ? {} : { modelLoadMs: coldMs }),
        ...(lastClipSeconds === undefined ? {} : { lastClipSeconds }),
      };
    },

    reset() {
      coldMs = undefined;
      warm.length = 0;
      lastClipSeconds = undefined;
    },
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (sorted.length % 2 === 1 || left === undefined || right === undefined) {
    return sorted[middle] ?? 0;
  }
  return (left + right) / 2;
}
