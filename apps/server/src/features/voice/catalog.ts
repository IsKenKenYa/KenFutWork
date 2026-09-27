/**
 * 内置模型目录（规划 §5）：三段的候选都来自这张表，界面按它出卡片。
 *
 * 校验和与体积是**逐文件钉死**的（2026-09-26 从上游仓库实地取回后算得）。
 * 为什么钉死而不在运行期问上游 API：运行期取校验值等于「上游说什么就信什么」，
 * 校验的意义就没了；钉死之后上游换文件必然被拒，是 fail loud 而不是静默换血。
 * 代价是上游版本更新要同步改本表——与 `scripts/fetch-runtimes.mjs` 同一取舍。
 *
 * **未入选的候选与原因**（不摆空壳，故不登记）：
 * - 内置「想」（离线 LLM）：体现为一个 GGUF 文件（规划 §3.2 的 Qwen3-4B-Instruct-2507
 *   Q4_K_M，2.5GB），但要跑它必须再引一个 GGUF 推理运行时（llama.cpp 一类）——
 *   `sherpa-onnx` 跑不了 LLM。加运行时是**新的依赖决策**，不是接线细节，故本轮不引；
 *   离线「想」当前的可走路径：本机起 llama.cpp / ollama，把它的 OpenAI 兼容地址加成一个
 *   BYOK 实例，再在「想」段选它（与 GPU 端点同一条路，见《多语言》外的 §3.4 口径）。
 * - sherpa 的 zh 系列 TTS（vits-zh-ll 等）：仓库未声明许可，与 GPL-3.0 的兼容性
 *   无从确认，故选许可明确的 Kokoro（Apache-2.0）。
 */

import type { VoiceSegmentKind } from "@kenfutwork/shared";

import { KOKORO_MULTI_LANG_FILES } from "./model-manifests/kokoro-multi-lang.files.js";

/** 模型目录内的一个文件（含子目录相对路径）+ 校验信息。 */
export interface BuiltinFileSpec {
  /** 相对模型目录的路径（含子目录，如 `dict/jieba.dict.utf8`）。 */
  path: string;
  url: string;
  sizeBytes: number;
  sha256: string;
}

export interface BuiltinVoiceModelSpec {
  id: string;
  /** 服务于哪一段；VAD 是内部优化，不属于任何一段。 */
  segment: VoiceSegmentKind | "vad";
  label: string;
  /** 许可与署名（内置离线模型必须有，规划 §10 风险 7）。 */
  license: string;
  /**
   * sherpa 配置的字段映射（相对模型目录的路径）。
   * 显式列出而不是从 `files` 猜：猜错了 sherpa 会静默忽略（VAD 甚至不抛错），
   * 而「哪些文件名对应哪个配置项」是模型自身的知识。catalog 的测试会校验
   * 这里每个路径都能在 `files` 里找到（防两处漂移）。
   */
  layout: {
    model: string;
    tokens?: string;
    lexicon?: string;
    dataDir?: string;
    voices?: string;
  };
  files: BuiltinFileSpec[];
}

/** 内置模型的总体积（下载前要显示，用户按体积决策）。 */
export function builtinModelSizeBytes(model: BuiltinVoiceModelSpec): number {
  return model.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

const HUGGING_FACE_SENSEVOICE =
  "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main";

/**
 * 听：SenseVoice Small int8（规划 §3.1）。
 * 选它的理由：普通话/粤语/英/日/韩，`use_itn=1` 带标点与逆文本规整，非自回归
 * （官方口径比 Whisper-Large 快 15 倍），且不需要 Python/PyTorch。
 * 2025-09-09 那一版虽用粤语微调但**不支持标点**，故不选。
 */
export const SENSE_VOICE: BuiltinVoiceModelSpec = {
  id: "sensevoice-small-int8",
  segment: "listen",
  label: "SenseVoice Small（int8）",
  // 权重走 FunASR 模型许可（需署名）；代码 MIT
  license: "FunASR Model License（权重）/ MIT（代码）；署名见设置 → 关于",
  layout: { model: "model.int8.onnx", tokens: "tokens.txt" },
  files: [
    {
      path: "model.int8.onnx",
      url: `${HUGGING_FACE_SENSEVOICE}/model.int8.onnx`,
      sizeBytes: 239_233_841,
      sha256:
        "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
    },
    {
      path: "tokens.txt",
      url: `${HUGGING_FACE_SENSEVOICE}/tokens.txt`,
      sizeBytes: 315_894,
      sha256:
        "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
    },
  ],
};

/**
 * 静音检测（内部优化，不属于三段）：silero-vad，约 629KB。
 * 不参与「能力是否可用」的判定——缺席只是少了掐头去尾（见 voice-service）。
 */
export const SILERO_VAD_MODEL: BuiltinVoiceModelSpec = {
  id: "silero-vad",
  segment: "vad",
  label: "Silero VAD（静音检测）",
  license: "MIT（silero-vad）",
  layout: { model: "silero_vad.onnx" },
  files: [
    {
      path: "silero_vad.onnx",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
      sizeBytes: 643_854,
      sha256:
        "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    },
  ],
};

/**
 * 说：Kokoro 多语版（规划 §3.3 的候选）。
 *
 * 选它的理由：许可是明确的 **Apache-2.0（含权重）**——本项目 GPL-3.0 兼容；
 * 82M 参数、CPU 上可实时。代价是文件多（375 个 / 382.6MB，含整棵 espeak-ng-data
 * 音素数据树），清单单独成文件（`model-manifests/`）。
 * espeak-ng-data 本身随 espeak-ng 走 GPL-3.0，与本项目同向，不额外加限制。
 */
export const KOKORO_MULTI_LANG: BuiltinVoiceModelSpec = {
  id: "kokoro-multi-lang",
  segment: "speak",
  label: "Kokoro 多语版（82M）",
  license:
    "Apache-2.0（模型权重与代码）；含 espeak-ng 音素数据（GPL-3.0）。署名见设置 → 关于",
  layout: {
    model: "model.onnx",
    voices: "voices.bin",
    tokens: "tokens.txt",
    lexicon: "lexicon-zh.txt",
    dataDir: "espeak-ng-data",
  },
  files: [...KOKORO_MULTI_LANG_FILES],
};

/** 全部内置模型（下载/删除只认这张表里的 id——别的 id 一律拒，不做任意 URL 下载器）。 */
export const BUILTIN_VOICE_MODELS: readonly BuiltinVoiceModelSpec[] = [
  SENSE_VOICE,
  KOKORO_MULTI_LANG,
  SILERO_VAD_MODEL,
];

export function findBuiltinModel(
  modelId: string,
): BuiltinVoiceModelSpec | undefined {
  return BUILTIN_VOICE_MODELS.find((model) => model.id === modelId);
}

/** 内置模型的体积（选择器卡片显示用；未知 id 回 0）。 */
export function builtinModelSize(modelId: string): number {
  const model = findBuiltinModel(modelId);
  return model ? builtinModelSizeBytes(model) : 0;
}
