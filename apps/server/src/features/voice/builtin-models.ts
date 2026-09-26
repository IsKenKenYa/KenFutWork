/**
 * 内置模型的落盘位置与文件布局（规划 §2.2 / §5）。
 *
 * 这里是**唯一**说清「内置模型放哪、叫什么文件」的地方：解析（voice-service）与
 * 下载（规划 §5，按需下载）必须同一处取值，否则会出现「下载到 A、加载找 B」——
 * 228MB 级模型下这种漂移排查代价极高。
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { ServerEnv } from "../../config/env.js";

/** 内置模型目录名（用户主目录下的隐藏目录，与 `~/.kenfutwork` 其它内容同级）。 */
const VOICE_MODELS_DIR = ".kenfutwork";
const VOICE_MODELS_SUBDIR = "models";

/**
 * 内置模型根目录：桌面形态在应用数据目录下（随桌面数据一起可清理），
 * 其余形态落 `~/.kenfutwork/models/<模型 id>/`。
 */
export function resolveVoiceModelsRoot(
  env: Pick<ServerEnv, "desktopDataDir">,
): string {
  if (env.desktopDataDir) {
    return join(env.desktopDataDir, VOICE_MODELS_SUBDIR);
  }
  return join(homedir(), VOICE_MODELS_DIR, VOICE_MODELS_SUBDIR);
}

/** 一个内置模型在磁盘上的文件布局（相对模型目录的文件名）。 */
export interface BuiltinModelFiles {
  /** 主 onnx 文件。 */
  model: string;
  /** 词表。 */
  tokens: string;
  /** 中文发音词典（vits/matcha 系 TTS）。 */
  lexicon?: string;
  /** 多说话人音色目录（vits 系 TTS）。 */
  dataDir?: string;
  /** kokoro 音色包。 */
  voices?: string;
}

export interface BuiltinListenModel {
  id: string;
  label: string;
  files: Required<Pick<BuiltinModelFiles, "model" | "tokens">>;
  /** 体积（字节）：下载前就要显示，用户按体积决策（规划 §5）。 */
  sizeBytes: number;
}

/**
 * 默认「听」模型：SenseVoice Small int8（规划 §3.1）。
 * 选它的理由：普通话/粤语/英/日/韩，`use_itn=1` 带标点与逆文本规整，非自回归
 * （官方口径比 Whisper-Large 快 15 倍），228MB 且不需要 Python/PyTorch。
 * 2025-09-09 那一版虽用粤语微调但**不支持标点**，故不选。
 */
export const SENSE_VOICE_SMALL_INT8: BuiltinListenModel = {
  id: "sensevoice-small-int8",
  label: "SenseVoice Small（int8）",
  files: { model: "model.int8.onnx", tokens: "tokens.txt" },
  sizeBytes: 228 * 1024 * 1024,
};

/** 默认静音检测（VAD）模型：silero-vad（约 2MB，离线切句用）。 */
export const SILERO_VAD: {
  id: string;
  label: string;
  files: Required<Pick<BuiltinModelFiles, "model">>;
  sizeBytes: number;
} = {
  id: "silero-vad",
  label: "Silero VAD",
  files: { model: "silero_vad.onnx" },
  sizeBytes: 2 * 1024 * 1024,
};

/** 解析某个内置模型的目录绝对路径。 */
export function resolveBuiltinModelDir(root: string, modelId: string): string {
  return join(root, modelId);
}

/** 模型目录 id 必须能安全当目录名用（挡住 `../` 一类越目录注入）。 */
export function isValidBuiltinModelId(modelId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(modelId) && !modelId.includes("..");
}
