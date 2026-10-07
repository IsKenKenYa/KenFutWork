/**
 * 浏览器侧的语音采集：录音 → 16kHz 单声道 WAV（规划 §7）。
 *
 * 为什么自己编码 WAV：服务端与 provider 都不需要 ffmpeg，也不引入转码依赖。
 * 链路是 `getUserMedia` → `MediaRecorder`（webm/opus）→ `decodeAudioData`
 * → 线性重采样到 16k → 手写 WAV 编码。
 *
 * 纯函数（WAV 编码 / 重采样 / 下混）单独导出以便单测；采集与解码那层薄壳靠注入
 * 才能在 jsdom 里跑（那边没有 getUserMedia / MediaRecorder / AudioContext）。
 */

/** 语音链路的采样率口径：SenseVoice 与 silero-vad 都按 16k 训练。 */
export const VOICE_SAMPLE_RATE = 16_000;

/** 归一化浮点 → 16 位整数（钳位，超范围不绕回）。 */
export function floatToPcm16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? clamped * 32_768 : clamped * 32_767;
}

/** 编码 16 位单声道 PCM WAV（服务端能解，浏览器也能直接播）。 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 1) {
    throw new Error(`采样率非法：${sampleRate}`);
  }
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, floatToPcm16(samples[i] ?? 0), true);
  }
  return bytes;
}

/** 线性重采样（16k ASR 对线性插值足够，不值得为它引 SRC 库）。 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) {
    return samples;
  }
  if (fromRate < 1 || toRate < 1) {
    throw new Error(`重采样率非法：${fromRate} → ${toRate}`);
  }
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i / ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    const a = samples[left] ?? 0;
    const b = samples[right] ?? 0;
    out[i] = a + (b - a) * weight;
  }
  return out;
}

/** 解码后的多声道 → 单声道（取均值；语音只要一路）。 */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) {
    return new Float32Array(0);
  }
  if (channels.length === 1) {
    return first;
  }
  const mono = new Float32Array(first.length);
  for (let i = 0; i < first.length; i += 1) {
    let sum = 0;
    for (const channel of channels) {
      sum += channel[i] ?? 0;
    }
    mono[i] = sum / channels.length;
  }
  return mono;
}

/** 一段录好的音频（已转成服务端要的形状）。 */
export interface VoiceClip {
  wav: Uint8Array;
  durationMs: number;
}

/** 录音会话：`stop()` 取回成品，`discard()` 丢弃（取消路径不留资源）。 */
export interface VoiceRecording {
  stop(): Promise<VoiceClip>;
  discard(): void;
}

/** 采集缝：测试注入假录音器（jsdom 没有 getUserMedia/MediaRecorder）。 */
export interface VoiceRecorder {
  start(): Promise<VoiceRecording>;
}

export class VoiceCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceCaptureError";
  }
}

/** 录音格式优先级：opus 体积小、浏览器支持广；都不支持时交给浏览器默认。 */
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  return PREFERRED_MIME_TYPES.find((type) =>
    typeof MediaRecorder.isTypeSupported === "function"
      ? MediaRecorder.isTypeSupported(type)
      : false,
  );
}

/** 解码只用得上这两件事：接口按需要收窄，测试就不必伪造整个 AudioContext。 */
export interface VoiceDecodeContext {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  close?: () => Promise<void>;
}

/** 把录音 blob 解码 → 下混 → 重采样 16k → 编码 WAV。 */
export async function blobToVoiceWav(
  blob: Blob,
  // 用 OfflineAudioContext：解码不需要输出设备，也不吃浏览器的自动播放策略
  createContext: () => VoiceDecodeContext = () =>
    new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE),
): Promise<{ wav: Uint8Array; durationMs: number }> {
  const context = createContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let i = 0; i < decoded.numberOfChannels; i += 1) {
      channels.push(decoded.getChannelData(i));
    }
    const mono = downmixToMono(channels);
    const resampled = resampleLinear(
      mono,
      decoded.sampleRate,
      VOICE_SAMPLE_RATE,
    );
    if (resampled.length === 0) {
      throw new VoiceCaptureError("这段录音里没有音频数据。");
    }
    return {
      wav: encodeWav(resampled, VOICE_SAMPLE_RATE),
      durationMs: Math.round((resampled.length / VOICE_SAMPLE_RATE) * 1000),
    };
  } finally {
    // 用完关掉：离线上下文没有物理资源，但保持这个口径，
    // 将来换成在线 AudioContext 时不会漏关
    if (typeof context.close === "function") {
      void context.close().catch(() => undefined);
    }
  }
}

/** 真实录音器（浏览器）。权限/设备失败一律转成可读中文原因。 */
export function createBrowserRecorder(): VoiceRecorder {
  return {
    async start() {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        throw new VoiceCaptureError(
          "当前环境拿不到麦克风（需要安全上下文或用桌面端）。",
        );
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        throw new VoiceCaptureError(
          name === "NotAllowedError"
            ? "麦克风权限被拒绝。到系统或浏览器设置里允许后再试。"
            : `打不开麦克风：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();

      const releaseStream = () => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      };

      return {
        async stop() {
          if (recorder.state !== "inactive") {
            recorder.stop();
          }
          await stopped;
          releaseStream();
          const blob = new Blob(chunks, {
            type: mimeType ?? recorder.mimeType ?? "audio/webm",
          });
          return blobToVoiceWav(blob);
        },
        discard() {
          if (recorder.state !== "inactive") {
            recorder.stop();
          }
          releaseStream();
        },
      };
    },
  };
}
