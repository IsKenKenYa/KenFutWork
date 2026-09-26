import { describe, expect, it, vi } from "vitest";

import { decodeWav, encodeWav } from "../audio.js";
import type { VoiceActivityDetector } from "../types.js";
import {
  createSherpaProvider,
  type SherpaModule,
  type SherpaSpeechSegment,
} from "./sherpa.js";

/**
 * 单测拿**桩模块**跑：真实模块要两百兆级模型才建得起来，桩模块能把
 * 「转写/合成/切句」的逻辑与「配置传给 sherpa 的形状」都钉死。
 * 配置形状不是实现细节——写错字段名 sherpa 会静默忽略（Vad 甚至不抛错），
 * 只能靠断言钉住。
 */

interface Recorder {
  recognizerConfigs: unknown[];
  ttsConfigs: unknown[];
  vadConfigs: unknown[];
  acceptedWaveforms: Array<{ samples: Float32Array; sampleRate: number }>;
  vadSegments: SherpaSpeechSegment[];
  flushCalls: number;
  texts: string[];
  ttsCalls: Array<{ text: string; sid: number; speed: number }>;
  resultText: string;
  sampleRate: number;
}

function stubModule(
  options: { numSpeakers?: number; sampleRate?: number } = {},
) {
  const recorder: Recorder = {
    recognizerConfigs: [],
    ttsConfigs: [],
    vadConfigs: [],
    acceptedWaveforms: [],
    vadSegments: [],
    flushCalls: 0,
    vadCalls: [],
    texts: [],
    ttsCalls: [],
    resultText: "  你好，世界。  ",
    sampleRate: options.sampleRate ?? 22_050,
  };
  const module: SherpaModule = {
    OfflineRecognizer: class {
      constructor(config: unknown) {
        recorder.recognizerConfigs.push(config);
      }
      createStream() {
        return {
          acceptWaveform: (obj: {
            samples: Float32Array;
            sampleRate: number;
          }) => {
            recorder.acceptedWaveforms.push(obj);
          },
        };
      }
      decode() {}
      getResult() {
        return { text: recorder.resultText };
      }
    } as unknown as SherpaModule["OfflineRecognizer"],
    OfflineTts: class {
      numSpeakers = options.numSpeakers ?? 1;
      sampleRate = recorder.sampleRate;
      constructor(config: unknown) {
        recorder.ttsConfigs.push(config);
      }
      generate(obj: { text: string; sid: number; speed: number }) {
        recorder.ttsCalls.push(obj);
        // 1 秒 440Hz 方波，好验证编码出的确实是可用 WAV
        const samples = new Float32Array(recorder.sampleRate);
        for (let i = 0; i < samples.length; i += 1) {
          samples[i] = i % 100 < 50 ? 0.5 : -0.5;
        }
        return { samples, sampleRate: recorder.sampleRate };
      }
    } as unknown as SherpaModule["OfflineTts"],
    Vad: class {
      constructor(config: unknown) {
        recorder.vadConfigs.push(config);
      }
      acceptWaveform() {
        recorder.vadCalls.push("accept");
      }
      isEmpty() {
        return recorder.vadSegments.length === 0;
      }
      front() {
        return recorder.vadSegments[0] as SherpaSpeechSegment;
      }
      pop() {
        recorder.vadSegments.shift();
      }
      flush() {
        recorder.flushCalls += 1;
        recorder.vadCalls.push("flush");
      }
      reset() {
        recorder.vadCalls.push("reset");
      }
    } as unknown as SherpaModule["Vad"],
  };
  return { module, recorder };
}

const ASR = {
  model: "/models/asr/model.int8.onnx",
  tokens: "/models/asr/tokens.txt",
};
const TTS = {
  kind: "vits" as const,
  model: "/models/tts/model.onnx",
  tokens: "/models/tts/tokens.txt",
  lexicon: "/models/tts/lexicon.txt",
};
const VAD = { model: "/models/vad/silero_vad.onnx" };

const allFiles = async () => true;
const noFiles = async () => false;

describe("sherpa 内置 Provider：就绪判定", () => {
  it("三段都缺席时逐段回「未下载」，不构造实例", async () => {
    const { module, recorder } = stubModule();
    const provider = createSherpaProvider({
      models: {},
      loadModule: () => module,
      fileExists: allFiles,
    });
    expect(provider.transcriber).toBeUndefined();
    expect(provider.synthesizer).toBeUndefined();
    expect(provider.vad).toBeUndefined();
    expect(recorder.recognizerConfigs).toHaveLength(0);
  });

  it("模型已配置但文件缺失：报缺失文件路径（UI 靠它写清为什么置灰）", async () => {
    const { module } = stubModule();
    const provider = createSherpaProvider({
      models: { asr: ASR, tts: TTS, vad: VAD },
      loadModule: () => module,
      fileExists: noFiles,
    });
    const verdict = await provider.transcriber?.ready();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.reason).toContain(ASR.model);
    const ttsVerdict = await provider.synthesizer?.ready();
    expect(ttsVerdict?.reason).toContain(TTS.lexicon);
  });

  it("运行时载不进来时给可读原因（不让上层看到裸异常）", async () => {
    const provider = createSherpaProvider({
      models: { asr: ASR, tts: TTS, vad: VAD },
      loadModule: () => {
        throw new Error("Cannot find module 'sherpa-onnx-node'");
      },
      fileExists: allFiles,
    });
    const verdict = await provider.transcriber?.ready();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.reason).toContain("sherpa-onnx-node");
    // 载入结论只算一次：失败后不再反复尝试（反复 dlopen 失败没有意义）
    await provider.transcriber?.ready();
    expect(verdict?.reason).toContain("sherpa-onnx-node");
  });

  it("全部就绪：ok，且**不**在 ready 阶段建模型实例（懒加载）", async () => {
    const { module, recorder } = stubModule();
    const loadSpy = vi.fn(() => module);
    const provider = createSherpaProvider({
      models: { asr: ASR, tts: TTS, vad: VAD },
      loadModule: loadSpy,
      fileExists: allFiles,
    });
    expect((await provider.transcriber?.ready())?.ok).toBe(true);
    expect((await provider.synthesizer?.ready())?.ok).toBe(true);
    expect((await provider.vad?.ready())?.ok).toBe(true);
    expect(loadSpy).toHaveBeenCalledTimes(1); // 模块结论复用
    expect(recorder.recognizerConfigs).toHaveLength(0); // 模型还没建
    expect(recorder.ttsConfigs).toHaveLength(0);
    expect(recorder.vadConfigs).toHaveLength(0);
  });
});

describe("sherpa 内置 Provider：听", () => {
  it("转写：把 WAV 解成 16k 单声道喂给识别器，返回去空格文本", async () => {
    const { module, recorder } = stubModule();
    const provider = createSherpaProvider({
      models: { asr: ASR },
      loadModule: () => module,
      fileExists: allFiles,
    });
    const wav = encodeWav(new Float32Array(800), 16_000);
    const result = await provider.transcriber?.transcribe(wav);
    expect(result?.text).toBe("你好，世界。");
    expect(recorder.acceptedWaveforms).toHaveLength(1);
    expect(recorder.acceptedWaveforms[0]?.sampleRate).toBe(16_000);
    expect(recorder.acceptedWaveforms[0]?.samples).toHaveLength(800);
  });

  it("转写：非 16k 输入按比例重采样（8k 输入 → 16k 输出翻倍）", async () => {
    const { module, recorder } = stubModule();
    const provider = createSherpaProvider({
      models: { asr: ASR },
      loadModule: () => module,
      fileExists: allFiles,
    });
    const wav = encodeWav(new Float32Array(400), 8_000);
    await provider.transcriber?.transcribe(wav);
    expect(recorder.acceptedWaveforms[0]?.samples).toHaveLength(800);
    expect(recorder.acceptedWaveforms[0]?.sampleRate).toBe(16_000);
  });

  it("转写：识别器只建一次（多轮复用），配置交给 sherpa 的形状被钉死", async () => {
    const { module, recorder } = stubModule();
    const provider = createSherpaProvider({
      models: { asr: ASR },
      numThreads: 3,
      loadModule: () => module,
      fileExists: allFiles,
    });
    const wav = encodeWav(new Float32Array(160), 16_000);
    await provider.transcriber?.transcribe(wav);
    await provider.transcriber?.transcribe(wav);
    expect(recorder.recognizerConfigs).toHaveLength(1);
    expect(recorder.recognizerConfigs[0]).toEqual({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: ASR.model,
          language: "auto",
          useInverseTextNormalization: 1,
        },
        tokens: ASR.tokens,
        numThreads: 3,
        provider: "cpu",
      },
    });
  });

  it("未就绪即转写：fail loud（不静默回空文本）", async () => {
    const { module } = stubModule();
    const provider = createSherpaProvider({
      models: { asr: ASR },
      loadModule: () => module,
      fileExists: noFiles,
    });
    await expect(
      provider.transcriber?.transcribe(encodeWav(new Float32Array(8), 16_000)),
    ).rejects.toThrow(/模型文件缺失/);
  });

  it("坏 WAV 输入：fail loud 且在解码前就失败（不白建识别器）", async () => {
    const { module, recorder } = stubModule();
    const provider = createSherpaProvider({
      models: { asr: ASR },
      loadModule: () => module,
      fileExists: allFiles,
    });
    await expect(
      provider.transcriber?.transcribe(new Uint8Array(200)),
    ).rejects.toThrow(/RIFF\/WAVE/);
    // 解码失败就不该分配识别器（两百兆模型的构建成本不该为坏输入付）
    expect(recorder.recognizerConfigs).toHaveLength(0);
    expect(recorder.acceptedWaveforms).toHaveLength(0);
  });

  it("已取消的 signal：不进入解码", async () => {
    const { module } = stubModule();
    const provider = createSherpaProvider({
      models: { asr: ASR },
      loadModule: () => module,
      fileExists: allFiles,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.transcriber?.transcribe(encodeWav(new Float32Array(8), 16_000), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/已取消/);
  });
});

describe("sherpa 内置 Provider：说", () => {
  it("合成：返回可直接解的 16 位 WAV，采样率取模型自报值", async () => {
    const { module, recorder } = stubModule({ sampleRate: 24_000 });
    const provider = createSherpaProvider({
      models: { tts: TTS },
      loadModule: () => module,
      fileExists: allFiles,
    });
    const result = await provider.synthesizer?.synthesize("你好");
    expect(result?.mimeType).toBe("audio/wav");
    const decoded = decodeWav(result?.audio as Uint8Array);
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.samples).toHaveLength(24_000);
    expect(recorder.ttsCalls[0]).toEqual({ text: "你好", sid: 0, speed: 1 });
  });

  it("音色解析：合法 speaker id 透传，越界/非数字回落 0", async () => {
    const { module, recorder } = stubModule({ numSpeakers: 3 });
    const provider = createSherpaProvider({
      models: { tts: TTS },
      loadModule: () => module,
      fileExists: allFiles,
    });
    await provider.synthesizer?.synthesize("a", { voice: "2" });
    await provider.synthesizer?.synthesize("b", { voice: "9" });
    await provider.synthesizer?.synthesize("c", { voice: "en-female" });
    expect(recorder.ttsCalls.map((call) => call.sid)).toEqual([2, 0, 0]);
  });

  it("合成：TTS 配置形状钉死（vits 档带 lexicon/dataDir）", async () => {
    const { module, recorder } = stubModule();
    const provider = createSherpaProvider({
      models: { tts: { ...TTS, dataDir: "/models/tts/espeak" } },
      numThreads: 1,
      loadModule: () => module,
      fileExists: allFiles,
    });
    await provider.synthesizer?.synthesize("hi");
    expect(recorder.ttsConfigs[0]).toEqual({
      model: {
        vits: {
          model: TTS.model,
          tokens: TTS.tokens,
          lexicon: TTS.lexicon,
          dataDir: "/models/tts/espeak",
        },
        numThreads: 1,
        provider: "cpu",
      },
      maxNumSentences: 1,
    });
  });

  it("kokoro 档走 kokoro 配置面（voices 而非 lexicon 语义）", async () => {
    const { module, recorder } = stubModule();
    const provider = createSherpaProvider({
      models: {
        tts: {
          kind: "kokoro",
          model: "/models/kokoro/model.onnx",
          tokens: "/models/kokoro/tokens.txt",
          voices: "/models/kokoro/voices.bin",
        },
      },
      loadModule: () => module,
      fileExists: allFiles,
    });
    await provider.synthesizer?.synthesize("hi");
    const config = recorder.ttsConfigs[0] as {
      model: { kokoro: Record<string, unknown> };
    };
    expect(config.model.kokoro).toEqual({
      model: "/models/kokoro/model.onnx",
      tokens: "/models/kokoro/tokens.txt",
      voices: "/models/kokoro/voices.bin",
    });
  });

  it("空文本与未就绪：fail loud", async () => {
    const { module } = stubModule();
    const provider = createSherpaProvider({
      models: { tts: TTS },
      loadModule: () => module,
      fileExists: allFiles,
    });
    await expect(provider.synthesizer?.synthesize("   ")).rejects.toThrow(
      /文本为空/,
    );
    const missing = createSherpaProvider({
      models: { tts: TTS },
      loadModule: () => module,
      fileExists: noFiles,
    });
    await expect(missing.synthesizer?.synthesize("hi")).rejects.toThrow(
      /模型文件缺失/,
    );
  });
});

describe("sherpa 内置 Provider：VAD", () => {
  it("切句：按窗口喂入、**必须 flush**、返回 [起,止) 采样下标", async () => {
    const { module, recorder } = stubModule();
    // 在 8000 处切出一段 4000 样本
    recorder.vadSegments = [
      { start: 8_000, samples: new Float32Array(4_000) },
      { start: 20_000, samples: new Float32Array(1_000) },
    ];
    const provider = createSherpaProvider({
      models: { vad: VAD },
      loadModule: () => module,
      fileExists: allFiles,
    });
    const verdict = await provider.vad?.ready();
    expect(verdict?.ok).toBe(true);
    const vad = provider.vad as VoiceActivityDetector;
    const { segments } = vad.segment(new Int16Array(30_000));
    expect(segments).toEqual([
      [8_000, 12_000],
      [20_000, 21_000],
    ]);
    // 不 flush 会丢掉尾部未闭合段（表现为「最后几个字没识别出来」）
    expect(recorder.flushCalls).toBe(1);
  });

  it("每次切句前先 reset（实例跨调用复用，脏状态会让索引跑到音频长度之外）", async () => {
    const { module, recorder } = stubModule();
    recorder.vadSegments = [{ start: 0, samples: new Float32Array(100) }];
    const provider = createSherpaProvider({
      models: { vad: VAD },
      loadModule: () => module,
      fileExists: allFiles,
    });
    await provider.vad?.ready();

    provider.vad?.segment(new Int16Array(1_024));
    const afterFirst = [...recorder.vadCalls];
    recorder.vadSegments = [{ start: 0, samples: new Float32Array(100) }];
    provider.vad?.segment(new Int16Array(1_024));

    // 第一次：reset → 喂 → flush；第二次必须再 reset（否则读到上一次的尾巴）
    expect(afterFirst[0]).toBe("reset");
    const secondRun = recorder.vadCalls.slice(afterFirst.length);
    expect(secondRun[0]).toBe("reset");
    expect(recorder.vadCalls.filter((call) => call === "reset")).toHaveLength(
      2,
    );
  });

  it("VAD 配置形状钉死（silero 档 + 16k）", async () => {
    const { module, recorder } = stubModule();
    const provider = createSherpaProvider({
      models: { vad: { model: VAD.model, threshold: 0.7 } },
      loadModule: () => module,
      fileExists: allFiles,
    });
    await provider.vad?.ready();
    provider.vad?.segment(new Int16Array(1_024));
    const config = recorder.vadConfigs[0] as {
      sileroVad: Record<string, unknown>;
      sampleRate: number;
    };
    expect(config.sampleRate).toBe(16_000);
    expect(config.sileroVad.model).toBe(VAD.model);
    expect(config.sileroVad.threshold).toBe(0.7);
    expect(config.sileroVad.windowSize).toBe(512);
  });

  it("未就绪即切句：**抛错**而不是静默回空段（sherpa 构造器不抛错的坑）", async () => {
    const { module } = stubModule();
    // 分支 1：压根没走过 ready()（同步接口自己查不了文件，故必须拒绝）
    const fresh = createSherpaProvider({
      models: { vad: VAD },
      loadModule: () => module,
      fileExists: noFiles,
    });
    expect(() => fresh.vad?.segment(new Int16Array(64))).toThrow(/未就绪/);

    // 分支 2：ready() 已明确报「文件缺失」，之后切句也必须抛错——
    // 这条是回归锁：漏了它就会静默造出空句柄，表现为「录音后什么也没发生」
    const provider = createSherpaProvider({
      models: { vad: VAD },
      loadModule: () => module,
      fileExists: noFiles,
    });
    expect((await provider.vad?.ready())?.ok).toBe(false);
    expect(() => provider.vad?.segment(new Int16Array(64))).toThrow(/未就绪/);

    // 就绪之后放行（同一实例，验证门禁不是「一律拒绝」）
    const ok = createSherpaProvider({
      models: { vad: VAD },
      loadModule: () => module,
      fileExists: allFiles,
    });
    expect((await ok.vad?.ready())?.ok).toBe(true);
    expect(() => ok.vad?.segment(new Int16Array(64))).not.toThrow();
  });
});
