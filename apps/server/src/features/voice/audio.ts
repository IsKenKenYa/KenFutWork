/**
 * 语音链路的 WAV 编解码（纯函数，无 IO）。
 *
 * 为什么手写而不引依赖：规划 §7 定的是「录音 → 重采样 → 手写 WAV 编码」，服务端与
 * provider 因此都不需要 ffmpeg，也不引入转码依赖。客户端负责编码（浏览器给的是
 * webm/opus，得先 decodeAudioData 再编码），服务端负责**解码**（内置 sherpa 要的是
 * 归一化 Float32 样本）与**编码**（TTS 输出的 Float32 样本要回给浏览器）。
 *
 * 支持面收在「浏览器与常见供应商实际产出的 WAV」：PCM 8/16/24/32 位与 IEEE float
 * 32/64 位，多声道下混成单声道。其余一律 fail loud（可读中文原因），不猜。
 */

/** 解码后的波形：单声道、归一化到 [-1, 1]。 */
export interface DecodedWav {
  sampleRate: number;
  /** 与 `sampleRate` 同一时基的单声道样本。 */
  samples: Float32Array;
}

/** WAV 不可用（格式不支持/文件截断）：HTTP 层映射成 `invalid_input`。 */
export class VoiceAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceAudioError";
  }
}

const RIFF = 0x52_49_46_46; // "RIFF"
const WAVE = 0x57_41_56_45; // "WAVE"
const FMT = 0x66_6d_74_20; // "fmt "
const DATA = 0x64_61_74_61; // "data"

const WAV_HEADER_BYTES = 44;
/** 波形格式标识：1 = 整数 PCM，3 = IEEE 浮点。 */
const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;

interface WavFormat {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

/**
 * 解析 RIFF/WAVE 容器，返回单声道归一化样本。
 * 严格解析：结构不对、格式不支持、data 块不完整一律抛 `VoiceAudioError`（可读原因）。
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.byteLength < WAV_HEADER_BYTES) {
    throw new VoiceAudioError("音频数据过短，不是合法的 WAV 文件。");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== RIFF || view.getUint32(8, false) !== WAVE) {
    throw new VoiceAudioError("音频不是 RIFF/WAVE 容器。");
  }

  let format: WavFormat | undefined;
  let dataOffset = -1;
  let dataLength = 0;
  // chunk 排布：id(4) + size(4) + body(size)，size 为奇数时补 1 字节对齐
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > view.byteLength) {
      throw new VoiceAudioError("WAV 数据不完整（文件被截断）。");
    }
    if (id === FMT) {
      if (size < 16) {
        throw new VoiceAudioError("WAV 的 fmt 块不完整。");
      }
      format = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === DATA) {
      dataOffset = body;
      dataLength = size;
    }
    offset = body + size + (size % 2);
  }

  if (!format) {
    throw new VoiceAudioError("WAV 缺少 fmt 块。");
  }
  if (dataOffset < 0) {
    throw new VoiceAudioError("WAV 缺少 data 块。");
  }
  if (format.channels < 1) {
    throw new VoiceAudioError("WAV 声道数非法。");
  }
  if (format.sampleRate < 1) {
    throw new VoiceAudioError("WAV 采样率非法。");
  }

  const bytesPerSample = format.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1) {
    throw new VoiceAudioError(
      `不支持的位深：${format.bitsPerSample} 位（支持 8/16/24/32/64）。`,
    );
  }
  const frameBytes = bytesPerSample * format.channels;
  const frames = Math.floor(dataLength / frameBytes);
  if (frames < 1) {
    throw new VoiceAudioError("WAV 不含任何音频样本。");
  }
  const readSample = sampleReader(format, view);
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    // 多声道下混成单声道（均值）；语音只要一路，保留左声道会在双声道不同内容时丢信息
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      sum += readSample(
        dataOffset + frame * frameBytes + channel * bytesPerSample,
      );
    }
    samples[frame] = sum / format.channels;
  }
  return { sampleRate: format.sampleRate, samples };
}

function sampleReader(
  format: WavFormat,
  view: DataView,
): (byteOffset: number) => number {
  const { format: kind, bitsPerSample } = format;
  if (kind === FORMAT_FLOAT) {
    if (bitsPerSample === 32) {
      return (at) => view.getFloat32(at, true);
    }
    if (bitsPerSample === 64) {
      return (at) => view.getFloat64(at, true);
    }
    throw new VoiceAudioError(
      `不支持的浮点位深：${bitsPerSample} 位（支持 32/64）。`,
    );
  }
  if (kind !== FORMAT_PCM) {
    throw new VoiceAudioError(
      `不支持的 WAV 编码格式：${kind}（只支持整数 PCM 与 IEEE 浮点）。`,
    );
  }
  switch (bitsPerSample) {
    case 8:
      // 8 位 WAV 是无符号
      return (at) => (view.getUint8(at) - 128) / 128;
    case 16:
      return (at) => view.getInt16(at, true) / 32_768;
    case 24:
      return (at) => {
        const low = view.getUint8(at);
        const mid = view.getUint8(at + 1);
        const high = view.getInt8(at + 2);
        return ((high << 16) | (mid << 8) | low) / 8_388_608;
      };
    case 32:
      return (at) => view.getInt32(at, true) / 2_147_483_648;
    default:
      throw new VoiceAudioError(
        `不支持的整数位深：${bitsPerSample} 位（支持 8/16/24/32）。`,
      );
  }
}

/** 编码 16 位单声道 PCM WAV（浏览器 `decodeAudioData` 可直接播）。 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 1) {
    throw new VoiceAudioError(`采样率非法：${sampleRate}`);
  }
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, RIFF, false);
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  view.setUint32(8, WAVE, false);
  view.setUint32(12, FMT, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率 = 采样率 × 声道 × 位深/8
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, DATA, false);
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(
      WAV_HEADER_BYTES + i * 2,
      floatToPcm16(samples[i] ?? 0),
      true,
    );
  }
  return bytes;
}

/** 归一化浮点 → 16 位整数（钳位，超范围不绕回）。 */
export function floatToPcm16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? clamped * 32_768 : clamped * 32_767;
}

/** 16 位整数 → 归一化浮点。 */
export function pcm16ToFloat(pcm: Int16Array): Float32Array {
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    samples[i] = (pcm[i] ?? 0) / 32_768;
  }
  return samples;
}

/** 归一化浮点 → 16 位整数（VAD 接口收 Int16Array 用）。 */
export function floatToPcm16Array(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    pcm[i] = floatToPcm16(samples[i] ?? 0);
  }
  return pcm;
}

/**
 * 线性重采样。语音链路只在「输入采样率不是 16k」时用它（如外部上传 24k/48k WAV）；
 * 线性插值对 16k ASR 足够，不值得引入 SRC 库。
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) {
    return samples;
  }
  if (fromRate < 1 || toRate < 1) {
    throw new VoiceAudioError(`重采样率非法：${fromRate} → ${toRate}`);
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

/** 内置 ASR / VAD 的采样率口径（sherpa 的 SenseVoice 与 silero-vad 都按 16k 训练）。 */
export const VOICE_SAMPLE_RATE = 16_000;

/** WAV 的格式与时长（不解码样本：8MB 上传只为拿时长不值得全量解一遍）。 */
export interface WavProbe {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
}

/** 从头部读格式与时长（结构非法即抛 `VoiceAudioError`，与 `decodeWav` 同口径）。 */
export function probeWav(bytes: Uint8Array): WavProbe {
  if (bytes.byteLength < WAV_HEADER_BYTES) {
    throw new VoiceAudioError("音频数据过短，不是合法的 WAV 文件。");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== RIFF || view.getUint32(8, false) !== WAVE) {
    throw new VoiceAudioError("音频不是 RIFF/WAVE 容器。");
  }
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > view.byteLength) {
      throw new VoiceAudioError("WAV 数据不完整（文件被截断）。");
    }
    if (id === FMT && size >= 16) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === DATA) {
      dataLength = size;
    }
    offset = body + size + (size % 2);
  }
  if (sampleRate < 1 || channels < 1 || bitsPerSample < 1) {
    throw new VoiceAudioError("WAV 缺少可用的 fmt 块。");
  }
  const frameBytes = (bitsPerSample / 8) * channels;
  return {
    sampleRate,
    channels,
    durationSeconds: dataLength / frameBytes / sampleRate,
  };
}
