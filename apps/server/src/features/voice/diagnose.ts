/**
 * 性能检测（规划 §6）。
 *
 * 与规划的一处**有意偏差**（实测驱动，写在最显眼的地方）：
 * 规划说「听」用内置 4 秒中文样本 wav 实测。实测发现两个问题——
 * ① 合成音频（静音/类语音带）测出的 RTF 与真实语音差 1.3~4.8 倍
 *   （静音反而更慢：RTF 0.371 vs 真实 0.078），拿它当样本会误导；
 * ② 真语音样本要从第三方语料里挑一段打进仓库，许可来源无法逐一交代。
 * 故改为**用真实使用中录下的音频**做统计（只记音频时长与耗时，不记内容，符合 §8），
 * 首次调用单独记「模型载入耗时」。这样读数既真又无许可负担；代价是「还没说过话」
 * 时只能给 `pending` 与一句引导。想段的 TTFT 是主动探针（不依赖历史使用）。
 *
 * 硬件面用 `os` + `nvidia-smi` 尽力探测：探不到 GPU 不影响任何功能（规划 §3.4）。
 */

import { execFile } from "node:child_process";
import { cpus, platform, release, totalmem } from "node:os";
import { promisify } from "node:util";

import type {
  VoiceDiagnoseHardware,
  VoiceDiagnoseReport,
  VoiceDiagnoseSegment,
} from "@kenfutwork/shared";

import type { VoiceListenSummary } from "./timing-log.js";

const execFileAsync = promisify(execFile);

/** nvidia-smi 探测超时：探不到就当没有，绝不卡住检测。 */
const GPU_PROBE_TIMEOUT_MS = 2_000;

export async function collectHardware(): Promise<VoiceDiagnoseHardware> {
  const cores = cpus();
  const first = cores[0];
  return {
    cpuModel: first?.model?.trim() || "未知 CPU",
    cpuCores: Math.max(1, cores.length),
    totalMemoryBytes: totalmem(),
    platform: `${platform()} ${release()}`,
    ...(await probeGpu()),
  };
}

/** GPU 尽力探测（`nvidia-smi --query-gpu=name`）：没装/没卡都只是「探不到」。 */
async function probeGpu(): Promise<{ gpu?: string }> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      { timeout: GPU_PROBE_TIMEOUT_MS },
    );
    const names = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return names.length > 0 ? { gpu: names.join("、") } : {};
  } catch {
    // 没装 nvidia-smi / 没卡 / 超时：都不影响功能（规划 §3.4），静默即正确
    return {};
  }
}

/** 「听」段的结论：有实测就给读数，没有就给一句怎么拿到读数的引导。 */
export function listenSegment(
  summary: VoiceListenSummary,
  unavailableReason?: string,
): VoiceDiagnoseSegment {
  if (unavailableReason) {
    return { state: "unavailable", summary: unavailableReason };
  }
  if (summary.samples === 0) {
    return {
      state: "pending",
      summary:
        "还没有实测数据：按住输入框说一句话，这里就会显示真实耗时（只记耗时，不存录音内容）。",
      listen: {
        samples: 0,
        ...(summary.modelLoadMs === undefined
          ? {}
          : { modelLoadMs: summary.modelLoadMs }),
      },
    };
  }
  const rtf = summary.rtfMedian ?? 0;
  const load =
    summary.modelLoadMs === undefined
      ? ""
      : `，首次使用额外等 ${(summary.modelLoadMs / 1000).toFixed(1)}s（模型载入）`;
  return {
    state: "measured",
    summary: `实测 ${summary.samples} 次的中位实时率 ${rtf.toFixed(2)}${load}。`,
    listen: {
      samples: summary.samples,
      ...(summary.rtfMedian === undefined ? {} : { rtfMedian: rtf }),
      ...(summary.modelLoadMs === undefined
        ? {}
        : { modelLoadMs: summary.modelLoadMs }),
      ...(summary.lastClipSeconds === undefined
        ? {}
        : { lastClipSeconds: summary.lastClipSeconds }),
    },
  };
}

/** 「想」段的结论：TTFT 探针的读数，或为什么没测。 */
export function thinkSegment(
  measurement: { ttftSeconds: number; tokensPerSecond?: number } | undefined,
  unavailableReason?: string,
): VoiceDiagnoseSegment {
  if (unavailableReason) {
    return { state: "unavailable", summary: unavailableReason };
  }
  if (!measurement) {
    return {
      state: "pending",
      summary: "还没有「想」段的实测读数。",
    };
  }
  const speed =
    measurement.tokensPerSecond === undefined
      ? ""
      : `、${measurement.tokensPerSecond.toFixed(1)} tok/s`;
  return {
    state: "measured",
    summary: `首 token ${measurement.ttftSeconds.toFixed(2)}s${speed}。`,
    think: {
      ttftSeconds: measurement.ttftSeconds,
      ...(measurement.tokensPerSecond === undefined
        ? {}
        : { tokensPerSecond: measurement.tokensPerSecond }),
    },
  };
}

/**
 * 「说」段：内置 TTS 尚未提供（见 catalog 注释里未入选的原因），
 * 故当前恒为 `unavailable` 并写明「为什么」而不是给个假读数。
 */
export function speakSegment(reason?: string): VoiceDiagnoseSegment {
  return {
    state: "unavailable",
    summary:
      reason ??
      "语音合成还没有可用的模型档：内置档待定（许可与体积），「说」段目前只支持 BYOK 端点。",
  };
}

export function buildReport(input: {
  hardware: VoiceDiagnoseHardware;
  listen: VoiceDiagnoseSegment;
  think: VoiceDiagnoseSegment;
  speak: VoiceDiagnoseSegment;
  measuredAt?: Date;
}): VoiceDiagnoseReport {
  return {
    hardware: input.hardware,
    listen: input.listen,
    think: input.think,
    speak: input.speak,
    measuredAt: (input.measuredAt ?? new Date()).toISOString(),
  };
}
