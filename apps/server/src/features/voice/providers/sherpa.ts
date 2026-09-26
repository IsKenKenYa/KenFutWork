/**
 * 内置离线 Provider（规划 §2.2）：听 / 说 / VAD 三件都在本机 CPU 上跑，
 * 运行时是 `sherpa-onnx-node`（ONNX Runtime，**不需要 Python/PyTorch**）。
 *
 * 懒加载分两级，别混：
 * - **原生模块**（`.node`）在首次 `ready()` 时载入并缓存结论——只 dlopen；
 * - **模型**（recognizer / tts / vad 实例）在首次实际调用时才建，之后复用。
 * 这样设置页列三段候选（要问 ready）不会把两百兆级模型拉进内存。
 *
 * `loadModule` 可注入：单测拿桩模块跑「转写 / 合成 / 切句」的真实逻辑，不需要下模型。
 * 另有一条实测约束写在这里以免后人踩：**sherpa 的 Vad 构造器不抛错**（模型路径不存在时
 * 只打日志、句柄置空，之后每次调用都打 "vad is nullptr"），所以 VAD 的就绪判定**只能**
 * 靠文件存在性，不能靠构造失败——`ready()` 因此是 VAD 唯一的门禁。
 */

import { access } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  decodeWav,
  encodeWav,
  pcm16ToFloat,
  resampleLinear,
  VOICE_SAMPLE_RATE,
} from "../audio.js";
import type {
  VoiceActivityDetector,
  VoiceAvailability,
  VoiceProvider,
  VoiceSynthesizer,
  VoiceTranscriber,
} from "../types.js";

const nodeRequire = createRequire(import.meta.url);

/** silero-vad 的分帧宽度（模型按 512 样本窗口训练）。 */
const VAD_WINDOW_SIZE = 512;
/** VAD 内部环形缓冲时长（秒）：整段录音一次性喂入，给足余量。 */
const VAD_BUFFER_SECONDS = 300;
/** 默认线程数：留一个核给服务端自身，别把机器吃满。 */
const DEFAULT_NUM_THREADS = 2;

/* ------------------------------- 原生模块面 ------------------------------- */

export interface SherpaStream {
  acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
}

export interface SherpaRecognizerInstance {
  createStream(hotwords?: string): SherpaStream;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { text: string };
}

export interface SherpaTtsInstance {
  readonly numSpeakers: number;
  readonly sampleRate: number;
  generate(obj: { text: string; sid: number; speed: number }): {
    samples: Float32Array;
    sampleRate: number;
  };
}

export interface SherpaSpeechSegment {
  /** 该段在喂入波形中的起始采样点下标。 */
  start: number;
  samples: Float32Array;
}

export interface SherpaVadInstance {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(): SherpaSpeechSegment;
  pop(): void;
  /**
   * 把内部尚未「闭合」的尾段强制吐出。**必须调**：VAD 要等到尾部静音达
   * `minSilenceDuration` 才闭合一段，不 flush 就会丢掉录音最后一段话音
   * （表现为「最后几个字没识别出来」）。
   */
  flush(): void;
}

/** 本文件用到的 sherpa-onnx-node 导出面（只声明用到的，不抄整份 API）。 */
export interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => SherpaRecognizerInstance;
  OfflineTts: new (config: unknown) => SherpaTtsInstance;
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVadInstance;
}

/**
 * sherpa-onnx-node 是 CJS 原生插件且**没有类型声明**：用 createRequire 取它的导出，
 * 绕开两件事——① TS 找不到声明文件；② ESM 具名导出探测不全（实测 `import()` 的命名空间
 * 只暴露 `default`，其余导出都挂在 default 上）。
 */
export function loadSherpaModule(): SherpaModule {
  return nodeRequire("sherpa-onnx-node") as SherpaModule;
}

/* --------------------------------- 模型面 --------------------------------- */

export interface SherpaAsrModel {
  /** SenseVoice 的 onnx 文件（int8 档 228MB）。 */
  model: string;
  tokens: string;
}

export type SherpaTtsKind = "vits" | "matcha" | "kokoro";

export interface SherpaTtsModel {
  kind: SherpaTtsKind;
  model: string;
  tokens: string;
  /** vits/matcha 的中文发音词典。 */
  lexicon?: string;
  /** 多说话人模型的音色目录（vits 系列的 `dataDir`）。 */
  dataDir?: string;
  /** kokoro 的音色包文件。 */
  voices?: string;
  /** 默认音色（speaker id 或 kokoro 音色名）。 */
  voice?: string;
}

export interface SherpaVadModel {
  model: string;
  threshold?: number;
}

export interface SherpaModels {
  asr?: SherpaAsrModel;
  tts?: SherpaTtsModel;
  vad?: SherpaVadModel;
}

export interface SherpaProviderOptions {
  /**
   * 三段各要的文件路径。字段缺席 = 该段未安装（`ready()` 回「模型未下载」，不构造实例）
   * ——按需下载的口径（规划 §5）：**未选择 = 不下载**，所以缺席是常态。
   */
  models: SherpaModels;
  numThreads?: number;
  /** 测试注入：给桩模块即可跑通全链路。 */
  loadModule?: () => SherpaModule;
  /** 测试注入：模型文件存在性探测。 */
  fileExists?: (path: string) => Promise<boolean>;
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 建 sherpa 内置 Provider。三段共用**一份**模块载入结论与各自的实例缓存。
 */
export function createSherpaProvider(
  options: SherpaProviderOptions,
): VoiceProvider {
  const numThreads = options.numThreads ?? DEFAULT_NUM_THREADS;
  const loadModule = options.loadModule ?? loadSherpaModule;
  const fileExists = options.fileExists ?? defaultFileExists;

  /** 模块载入结论只算一次；失败即定局（重试还是失败），原因留给 UI 显示。 */
  let moduleState:
    | { kind: "ok"; module: SherpaModule }
    | { kind: "failed"; reason: string }
    | undefined;

  function ensureModule(): SherpaModule {
    if (!moduleState) {
      try {
        moduleState = { kind: "ok", module: loadModule() };
      } catch (error) {
        moduleState = {
          kind: "failed",
          reason: `语音运行时不可用（sherpa-onnx-node 未能载入）：${describeError(error)}`,
        };
      }
    }
    if (moduleState.kind === "failed") {
      throw new Error(moduleState.reason);
    }
    return moduleState.module;
  }

  /**
   * 段的就绪门禁：文件缺失 → 可读原因；运行时载入失败 → 可读原因；全过 → 放行。
   * 三段共用这一处逻辑（三段各自 copy 一份是屎山的起点）。
   */
  async function segmentReady(
    segmentLabel: string,
    requiredPaths: readonly string[] | undefined,
  ): Promise<VoiceAvailability> {
    if (!requiredPaths) {
      return { ok: false, reason: `未下载「${segmentLabel}」模型` };
    }
    const missing = (
      await Promise.all(
        requiredPaths.map(async (path) =>
          (await fileExists(path)) ? undefined : path,
        ),
      )
    ).filter((path): path is string => path !== undefined);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `「${segmentLabel}」模型文件缺失：${missing.join("、")}`,
      };
    }
    try {
      ensureModule();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: describeError(error) };
    }
  }

  /** 就绪即返回模块；未就绪 fail loud（HTTP 层映射成 503 service_unavailable）。 */
  async function requireModule(
    verdict: VoiceAvailability,
  ): Promise<SherpaModule> {
    if (!verdict.ok) {
      throw new Error(verdict.reason ?? "语音能力不可用。");
    }
    return ensureModule();
  }

  const asrPaths = options.models.asr
    ? [options.models.asr.model, options.models.asr.tokens]
    : undefined;
  const ttsModel = options.models.tts;
  const ttsPaths = ttsModel
    ? [
        ttsModel.model,
        ttsModel.tokens,
        ...(ttsModel.lexicon ? [ttsModel.lexicon] : []),
        ...(ttsModel.voices ? [ttsModel.voices] : []),
      ]
    : undefined;
  const vadPaths = options.models.vad ? [options.models.vad.model] : undefined;

  let recognizerInstance: SherpaRecognizerInstance | undefined;
  let ttsInstance: SherpaTtsInstance | undefined;
  let vadInstance: SherpaVadInstance | undefined;
  /** VAD 的就绪结论（`segment()` 只认它，见下方注释）。 */
  let vadVerified = false;

  const transcriber: VoiceTranscriber = {
    ready: () => segmentReady("听", asrPaths),
    async transcribe(wav, opts) {
      const model = options.models.asr;
      const module = await requireModule(await segmentReady("听", asrPaths));
      if (!model) {
        throw new Error("「听」模型未就绪（fail loud）。");
      }
      const decoded = decodeWav(wav);
      recognizerInstance ??= createRecognizer(module, model, numThreads);
      const stream = recognizerInstance.createStream();
      stream.acceptWaveform({
        // 内置 ASR 按 16k 训练：非 16k 输入（外部上传的 24k/48k WAV）在此线性重采样
        samples: resampleLinear(
          decoded.samples,
          decoded.sampleRate,
          VOICE_SAMPLE_RATE,
        ),
        sampleRate: VOICE_SAMPLE_RATE,
      });
      if (opts?.signal?.aborted) {
        throw new Error("转写已取消。");
      }
      recognizerInstance.decode(stream);
      return { text: recognizerInstance.getResult(stream).text.trim() };
    },
  };

  const synthesizer: VoiceSynthesizer = {
    ready: () => segmentReady("说", ttsPaths),
    async synthesize(text, opts) {
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("待合成的文本为空（fail loud）。");
      }
      const module = await requireModule(await segmentReady("说", ttsPaths));
      if (!ttsModel) {
        throw new Error("「说」模型未就绪（fail loud）。");
      }
      ttsInstance ??= createTts(module, ttsModel, numThreads);
      const generated = ttsInstance.generate({
        text: trimmed,
        sid: resolveSpeakerId(ttsInstance, opts?.voice ?? ttsModel.voice),
        speed: 1,
      });
      return {
        audio: encodeWav(generated.samples, generated.sampleRate),
        mimeType: "audio/wav",
      };
    },
  };

  const vad: VoiceActivityDetector = {
    /**
     * `segment()` 是同步方法（契约如此），没法自己 `await` 文件存在性，而 sherpa 的 Vad
     * 构造器**不抛错**——不设这道门，模型文件缺失时会静默造出一个空句柄，切句永远回空段，
     * 表现为「录音后什么也没发生」。故 VAD 必须**先过 ready() 再切句**：`ready()` 的结论
     * 记在这里，`segment()` 只认已验证的结论，不自己猜。
     */
    ready: async () => {
      const verdict = await segmentReady("静音检测", vadPaths);
      vadVerified = verdict.ok;
      return verdict;
    },
    segment(pcm) {
      const model = options.models.vad;
      if (!model) {
        throw new Error("静音检测未就绪（fail loud）。");
      }
      if (!vadVerified) {
        throw new Error(
          "静音检测未就绪：需先调用 ready() 校验模型文件（fail loud）。",
        );
      }
      const module = ensureModule();
      vadInstance ??= new module.Vad(
        {
          sileroVad: {
            model: model.model,
            threshold: model.threshold ?? 0.5,
            minSilenceDuration: 0.25,
            minSpeechDuration: 0.25,
            windowSize: VAD_WINDOW_SIZE,
            maxSpeechDuration: 15,
          },
          sampleRate: VOICE_SAMPLE_RATE,
          numThreads: 1,
          provider: "cpu",
        },
        VAD_BUFFER_SECONDS,
      );
      const samples = pcm16ToFloat(pcm);
      for (let offset = 0; offset < samples.length; offset += VAD_WINDOW_SIZE) {
        vadInstance.acceptWaveform(
          samples.subarray(offset, offset + VAD_WINDOW_SIZE),
        );
      }
      vadInstance.flush();
      const segments: Array<[number, number]> = [];
      while (!vadInstance.isEmpty()) {
        const segment = vadInstance.front();
        segments.push([segment.start, segment.start + segment.samples.length]);
        vadInstance.pop();
      }
      return { segments };
    },
  };

  return {
    id: "builtin-sherpa",
    label: "内置（本机 CPU）",
    location: "cpu",
    ...(options.models.asr ? { transcriber } : {}),
    ...(options.models.tts ? { synthesizer } : {}),
    ...(options.models.vad ? { vad } : {}),
  };
}

function createRecognizer(
  module: SherpaModule,
  model: SherpaAsrModel,
  numThreads: number,
): SherpaRecognizerInstance {
  return new module.OfflineRecognizer({
    featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: model.model,
        // auto = 模型自行判定中/英/粤/日/韩，别写死 zh 把英文识别锁死
        language: "auto",
        // 带标点与逆文本规整：口语转书写（「三点五」→「3.5」）
        useInverseTextNormalization: 1,
      },
      tokens: model.tokens,
      numThreads,
      provider: "cpu",
    },
  });
}

function createTts(
  module: SherpaModule,
  model: SherpaTtsModel,
  numThreads: number,
): SherpaTtsInstance {
  const shared = {
    model: model.model,
    tokens: model.tokens,
    ...(model.lexicon ? { lexicon: model.lexicon } : {}),
  };
  const ttsModel =
    model.kind === "kokoro"
      ? {
          kokoro: {
            ...shared,
            ...(model.voices ? { voices: model.voices } : {}),
            ...(model.dataDir ? { dataDir: model.dataDir } : {}),
          },
        }
      : {
          [model.kind]: {
            ...shared,
            ...(model.dataDir ? { dataDir: model.dataDir } : {}),
          },
        };
  return new module.OfflineTts({
    model: { ...ttsModel, numThreads, provider: "cpu" },
    // 语音回复是一句一合成，一次一节即可（多句会让首包变慢）
    maxNumSentences: 1,
  });
}

/**
 * 音色解析：内置路径的 voice 是 **speaker id**（多说话人 vits 系列），
 * 非数字或超范围一律回落 0（单说话人模型只有 0，写死别的会直接报错）。
 */
function resolveSpeakerId(tts: SherpaTtsInstance, voice?: string): number {
  const parsed = voice === undefined ? Number.NaN : Number.parseInt(voice, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= tts.numSpeakers) {
    return 0;
  }
  return parsed;
}
