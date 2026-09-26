import { describe, expect, it, vi } from "vitest";

import {
  blobToVoiceWav,
  createBrowserRecorder,
  downmixToMono,
  encodeWav,
  floatToPcm16,
  resampleLinear,
  type VoiceDecodeContext,
  VOICE_SAMPLE_RATE,
  VoiceCaptureError,
} from "../src/lib/voice-audio.js";

/**
 * 采集侧的纯逻辑。WAV 编码与重采样是「服务端能不能吃」的边界，
 * 必须与服务端 audio.ts 的口径一致（这里按同一套断言钉住）。
 */

/** 造一个最小可解析的 WAV，用来验证编码结果（不依赖服务端代码，避免自证）。 */
function parseWav(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readAscii = (offset: number, length: number) =>
    String.fromCharCode(
      ...Array.from({ length }, (_, i) => view.getUint8(offset + i)),
    );
  return {
    riff: readAscii(0, 4),
    wave: readAscii(8, 4),
    fmt: readAscii(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataTag: readAscii(36, 4),
    dataBytes: view.getUint32(40, true),
    riffSize: view.getUint32(4, true),
    sample: (index: number) => view.getInt16(44 + index * 2, true),
  };
}

describe("encodeWav（浏览器侧 16k 单声道 WAV 编码）", () => {
  it("头部字段齐全且自洽（RIFF/WAVE/fmt/data、单声道 16 位）", () => {
    const wav = encodeWav(new Float32Array(800), VOICE_SAMPLE_RATE);
    const parsed = parseWav(wav);
    expect(parsed.riff).toBe("RIFF");
    expect(parsed.wave).toBe("WAVE");
    expect(parsed.fmt).toBe("fmt ");
    expect(parsed.dataTag).toBe("data");
    expect(parsed.audioFormat).toBe(1);
    expect(parsed.channels).toBe(1);
    expect(parsed.sampleRate).toBe(16_000);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.dataBytes).toBe(800 * 2);
    expect(parsed.riffSize).toBe(wav.byteLength - 8);
    // 字节率与块对齐要跟采样率一致，否则播放器会按错速度解
    expect(parsed.byteRate).toBe(16_000 * 2);
    expect(parsed.blockAlign).toBe(2);
    expect(wav.byteLength).toBe(44 + 1600);
  });

  it("样本值钳位且不绕回（+2 不能变成负数）", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]), 16_000);
    const parsed = parseWav(wav);
    expect(parsed.sample(0)).toBe(0);
    expect(parsed.sample(1)).toBeCloseTo(16_383, -1);
    expect(parsed.sample(2)).toBeCloseTo(-16_384, -1);
    expect(parsed.sample(3)).toBe(32_767);
    expect(parsed.sample(4)).toBe(-32_768);
  });

  it("采样率非法即抛（可读原因）", () => {
    expect(() => encodeWav(new Float32Array(1), 0)).toThrow(/采样率非法/);
    expect(() => encodeWav(new Float32Array(1), 16_000.5)).toThrow(
      /采样率非法/,
    );
  });

  it("floatToPcm16 的边界", () => {
    expect(floatToPcm16(0)).toBe(0);
    expect(floatToPcm16(-1)).toBe(-32_768);
    expect(floatToPcm16(1)).toBe(32_767);
    expect(floatToPcm16(-3)).toBe(-32_768);
    expect(floatToPcm16(3)).toBe(32_767);
  });
});

describe("resampleLinear", () => {
  it("同率原样返回（不拷贝）；空输入返回空", () => {
    const samples = new Float32Array([1, 2, 3]);
    expect(resampleLinear(samples, 16_000, 16_000)).toBe(samples);
    expect(resampleLinear(new Float32Array(0), 48_000, 16_000)).toHaveLength(0);
  });

  it("48k → 16k 三分之一下采样，长度按比例", () => {
    const out = resampleLinear(
      new Float32Array(4_800).fill(0.25),
      48_000,
      16_000,
    );
    expect(out).toHaveLength(1_600);
    for (const value of out) {
      expect(value).toBeCloseTo(0.25, 6);
    }
  });

  it("非法采样率即抛", () => {
    expect(() => resampleLinear(new Float32Array(4), 0, 16_000)).toThrow(
      /重采样率非法/,
    );
    expect(() => resampleLinear(new Float32Array(4), 16_000, 0)).toThrow(
      /重采样率非法/,
    );
  });
});

describe("downmixToMono", () => {
  it("多声道取均值；单声道原样透传；空输入回空数组", () => {
    const left = new Float32Array([1, -1, 0.5]);
    const right = new Float32Array([0, 1, 0.5]);
    expect(Array.from(downmixToMono([left, right]))).toEqual([0.5, 0, 0.5]);
    expect(downmixToMono([left])).toBe(left);
    expect(downmixToMono([])).toHaveLength(0);
  });
});

describe("blobToVoiceWav（解码 → 下混 → 重采样 → 编码）", () => {
  /** 桩音频上下文：只实现被用到的那两个方法。 */
  function fakeContext(options: {
    channels: Float32Array[];
    sampleRate: number;
    failDecode?: boolean;
  }) {
    return {
      decodeAudioData: async () => {
        if (options.failDecode) {
          throw new Error("Unable to decode audio data");
        }
        return {
          numberOfChannels: options.channels.length,
          sampleRate: options.sampleRate,
          getChannelData: (index: number) =>
            options.channels[index] as Float32Array,
        };
      },
      close: async () => undefined,
    } as unknown as VoiceDecodeContext;
  }

  it("44.1k 双声道输入：输出单声道 16k，时长按样本数折算", async () => {
    const frames = 44_100; // 1 秒
    const left = new Float32Array(frames).fill(0.5);
    const right = new Float32Array(frames).fill(-0.5);
    const result = await blobToVoiceWav(
      new Blob([new Uint8Array([1, 2, 3])]),
      () => fakeContext({ channels: [left, right], sampleRate: 44_100 }),
    );
    const parsed = parseWav(result.wav);
    expect(parsed.sampleRate).toBe(16_000);
    expect(parsed.channels).toBe(1);
    expect(result.durationMs).toBe(1_000);
    // 左右反相 → 下混后静音（也正是「取均值」而非「取左声道」的证据）
    expect(parsed.sample(100)).toBe(0);
  });

  it("解不开的音频：抛可读原因，不返回空 WAV", async () => {
    await expect(
      blobToVoiceWav(new Blob([new Uint8Array([1])]), () =>
        fakeContext({
          channels: [new Float32Array(10)],
          sampleRate: 16_000,
          failDecode: true,
        }),
      ),
    ).rejects.toThrow(/decode audio/i);
  });

  it("解出零样本：明确报错（别把空录音当成功提交）", async () => {
    await expect(
      blobToVoiceWav(new Blob([new Uint8Array([1])]), () =>
        fakeContext({ channels: [new Float32Array(0)], sampleRate: 16_000 }),
      ),
    ).rejects.toBeInstanceOf(VoiceCaptureError);
  });
});

describe("createBrowserRecorder（环境缺失时的可读拒绝）", () => {
  it("没有 mediaDevices 时给出中文原因（不是 undefined 报错）", async () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
    });
    try {
      await expect(createBrowserRecorder().start()).rejects.toThrow(
        /拿不到麦克风/,
      );
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: original,
        configurable: true,
      });
    }
  });

  it("权限被拒（NotAllowedError）：原因指向去哪里开权限", async () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: {
        mediaDevices: {
          getUserMedia: vi.fn(async () => {
            const error = new Error("denied");
            error.name = "NotAllowedError";
            throw error;
          }),
        },
      },
      configurable: true,
    });
    try {
      await expect(createBrowserRecorder().start()).rejects.toThrow(
        /权限被拒绝/,
      );
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: original,
        configurable: true,
      });
    }
  });
});
