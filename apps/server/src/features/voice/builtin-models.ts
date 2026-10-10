/**
 * 内置模型的落盘位置（规划 §2.2 / §5）。
 *
 * 这里是**唯一**说清「内置模型放哪」的地方：解析（voice-service）与下载（model-store）
 * 必须同一处取值，否则会出现「下载到 A、加载找 B」——两百兆级模型下这种漂移排查代价极高。
 * 模型各自**有哪些文件**不在这里，在 `catalog.ts`（那张表同时供下载与界面用）。
 */

import { join } from "node:path";
import type { ServerEnv } from "../../config/env.js";
import { resolveDesktopDataDir } from "../../desktop/paths.js";

const VOICE_MODELS_SUBDIR = "models";

/**
 * 内置模型根目录：桌面形态在应用数据目录下（随桌面数据一起可清理），
 * 其余形态落 `~/.kenfutwork/models/<模型 id>/`。
 */
export function resolveVoiceModelsRoot(
  env: Pick<ServerEnv, "desktopDataDir">,
): string {
  return join(
    resolveDesktopDataDir({
      env: { KENFUTWORK_DATA_DIR: env.desktopDataDir },
    }),
    VOICE_MODELS_SUBDIR,
  );
}

/** 某个内置模型的目录绝对路径。 */
export function resolveBuiltinModelDir(root: string, modelId: string): string {
  return join(root, modelId);
}

/**
 * 模型目录 id 必须能安全当目录名用（挡住 `../` 一类越目录注入）。
 * 下载路径由「目录 id + 表里的相对文件名」拼出，任何一段能穿越都会写到模型根之外。
 */
export function isValidBuiltinModelId(modelId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(modelId) && !modelId.includes("..");
}
