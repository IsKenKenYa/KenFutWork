import { describe, expect, it } from "vitest";

import {
  decodeWav,
  encodeWav,
  floatToPcm16,
  floatToPcm16Array,
  pcm16ToFloat,
  resampleLinear,
  VoiceAudioError,
} from "./audio.js";

/** 造一个最小合法 WAV（PCM 16 位；可指定声道数与采样率）。 */
function makeWav(
  samples: number[],
  options: { sampleRate?: number; channels?: number; bits?: number } = {},
): Uint8Array {
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const bytesPerSample = bits / 8;
  const dataBytes = samples.length * bytesPerSample;
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
  view.setUint16(20, bits === 32 ? 3 : 1, true); // 32 位按 IEEE 浮点造
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bits, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  samples.forEach((value, index) => {
    const at = 44 + index * bytesPerSample;
    if (bits === 32) {
      view.setFloat32(at, value, true);
    } else if (bits === 16) {
      view.setInt16(at, value, true);
    } else if (bits === 8) {
      view.setUint8(at, value);
    } else {
      throw new Error(`makeWav 不支持 ${bits} 位`);
    }
  });
  return bytes;
}

describe("decodeWav", () => {
  it("解析 PCM 16 位并归一化到 [-1, 1]", () => {
    const wav = makeWav([0, 16_384, -16_384, 32_767]);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.samples).toHaveLength(4);
    expect(decoded.samples[0]).toBe(0);
    expect(decoded.samples[1]).toBeCloseTo(0.5, 4);
    expect(decoded.samples[2]).toBeCloseTo(-0.5, 4);
    expect(decoded.samples[3]).toBeCloseTo(1, 3);
  });

  it("多声道下混成单声道（取均值）", () => {
    // 两帧 × 两声道：帧 0 = (16384, -16384) → 0；帧 1 = (32767, 32767) → ~1
    const wav = makeWav([16_384, -16_384, 32_767, 32_767], { channels: 2 });
    const decoded = decodeWav(wav);
    expect(decoded.samples).toHaveLength(2);
    expect(decoded.samples[0]).toBeCloseTo(0, 4);
    expect(decoded.samples[1]).toBeCloseTo(1, 3);
  });

  it("支持 IEEE 浮点 32 位（浏览器用 f32 WAV 的路径）", () => {
    const wav = makeWav([0.25, -0.75], { bits: 32 });
    const decoded = decodeWav(wav);
    expect(decoded.samples[0]).toBeCloseTo(0.25, 6);
    expect(decoded.samples[1]).toBeCloseTo(-0.75, 6);
  });

  it("支持 8 位无符号 PCM（128 是零点）", () => {
    const wav = makeWav([128, 255, 0], { bits: 8 });
    const decoded = decodeWav(wav);
    expect(decoded.samples[0]).toBeCloseTo(0, 6);
    expect(decoded.samples[1]).toBeCloseTo(0.992, 2);
    expect(decoded.samples[2]).toBe(-1);
  });

  it("跳过多余 chunk（含奇数长度 chunk 的补位对齐）", () => {
    const base = makeWav([1_000, 2_000]);
    // 在 fmt 与 data 之间插一个奇数长度的 chunk，其次字节是补位
    const extra = new Uint8Array(8 + 3 + 1);
    const extraView = new DataView(extra.buffer);
    for (let i = 0; i < 4; i += 1) {
      extraView.setUint8(i, "LIST".charCodeAt(i));
    }
    extraView.setUint32(4, 3, true);
    extra.set([1, 2, 3, 0], 8);
    const fmtEnd = 36;
    const merged = new Uint8Array(base.length + extra.length);
    merged.set(base.subarray(0, fmtEnd), 0);
    merged.set(extra, fmtEnd);
    merged.set(base.subarray(fmtEnd), fmtEnd + extra.length);
    const view = new DataView(merged.buffer);
    view.setUint32(4, merged.length - 8, true);
    const decoded = decodeWav(merged);
    expect(decoded.samples).toHaveLength(2);
    expect(decoded.samples[0]).toBeCloseTo(1_000 / 32_768, 6);
  });

  it("结构非法一律 fail loud（可读中文原因）", () => {
    expect(() => decodeWav(new Uint8Array(10))).toThrow(VoiceAudioError);
    expect(() => decodeWav(new Uint8Array(100))).toThrow(/RIFF\/WAVE/);

    // 缺 fmt：把 fmt chunk 的 id 改掉
    const noFmt = makeWav([1, 2]);
    new DataView(noFmt.buffer).setUint8(12, "x".charCodeAt(0));
    expect(() => decodeWav(noFmt)).toThrow(/fmt/);

    // 缺 data
    const noData = makeWav([1, 2]);
    new DataView(noData.buffer).setUint8(36, "x".charCodeAt(0));
    expect(() => decodeWav(noData)).toThrow(/data/);

    // 截断：data 声明长度超过文件实际长度
    const truncated = makeWav([1, 2, 3, 4]);
    new DataView(truncated.buffer).setUint32(40, 9_999, true);
    expect(() => decodeWav(truncated)).toThrow(/不完整/);

    // 不支持的编码格式（2 = ADPCM）
    const adpcm = makeWav([1, 2]);
    new DataView(adpcm.buffer).setUint16(20, 2, true);
    expect(() => decodeWav(adpcm)).toThrow(/编码格式/);

    // 不支持的位深
    const odd = makeWav([1, 2]);
    new DataView(odd.buffer).setUint16(34, 12, true);
    expect(() => decodeWav(odd)).toThrow(VoiceAudioError);

    // 声道数为 0
    const noChannel = makeWav([1, 2]);
    new DataView(noChannel.buffer).setUint16(22, 0, true);
    expect(() => decodeWav(noChannel)).toThrow(/声道数/);

    // 采样率 0
    const noRate = makeWav([1, 2]);
    new DataView(noRate.buffer).setUint32(24, 0, true);
    expect(() => decodeWav(noRate)).toThrow(/采样率/);
  });

  it("data 块短于一个采样帧即拒绝（不静默回空数组）", () => {
    const empty = makeWav([1, 2]);
    new DataView(empty.buffer).setUint32(40, 0, true);
    expect(() => decodeWav(empty)).toThrow(/不含任何音频样本/);
  });
});

describe("encodeWav", () => {
  it("编码后可原样解回（往返一致）", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.999, -0.999]);
    const encoded = encodeWav(samples, 24_000);
    const decoded = decodeWav(encoded);
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.samples).toHaveLength(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      expect(decoded.samples[i]).toBeCloseTo(samples[i] ?? 0, 4);
    }
  });

  it("采样率非法即 fail loud", () => {
    expect(() => encodeWav(new Float32Array(1), 0)).toThrow(VoiceAudioError);
    expect(() => encodeWav(new Float32Array(1), 16_000.5)).toThrow(
      VoiceAudioError,
    );
  });
});

describe("样本换算与重采样", () => {
  it("floatToPcm16 钳位而不绕回", () => {
    expect(floatToPcm16(2)).toBe(32_767);
    expect(floatToPcm16(-2)).toBe(-32_768);
    expect(floatToPcm16(0)).toBe(0);
  });

  it("pcm16ToFloat / floatToPcm16Array 互逆（int16 往返差 1 LSB 属正常）", () => {
    const pcm = new Int16Array([0, 16_384, -16_384, 32_767]);
    const floats = pcm16ToFloat(pcm);
    expect(floats[1]).toBeCloseTo(0.5, 4);
    const back = floatToPcm16Array(floats);
    // 负半轴有 -32768 而正半轴只到 32767，往返必然有 1 LSB 量化误差
    for (let i = 0; i < pcm.length; i += 1) {
      expect(Math.abs((back[i] ?? 0) - (pcm[i] ?? 0))).toBeLessThanOrEqual(1);
    }
  });

  it("重采样：同率原样返回，升/降采样长度按比例", () => {
    const samples = new Float32Array([0, 1, 0, -1, 0]);
    expect(resampleLinear(samples, 16_000, 16_000)).toBe(samples);

    const up = resampleLinear(samples, 8_000, 16_000);
    expect(up).toHaveLength(10);
    const down = resampleLinear(samples, 16_000, 8_000);
    expect(down).toHaveLength(3);

    // 直流信号重采样后仍是直流（插值不会造出虚假波动）
    const dc = new Float32Array(64).fill(0.5);
    for (const value of resampleLinear(dc, 48_000, 16_000)) {
      expect(value).toBeCloseTo(0.5, 6);
    }
  });

  it("重采样：空输入与非法率", () => {
    expect(resampleLinear(new Float32Array(0), 8_000, 16_000)).toHaveLength(0);
    expect(() => resampleLinear(new Float32Array(4), 0, 16_000)).toThrow(
      VoiceAudioError,
    );
  });
});
