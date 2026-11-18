/**
 * 语音设置的解析与部分更新（纯函数，无 IO）。
 *
 * 读回策略「逐字段回落」而非「整块丢弃」：库里是 jsonb，一个字段写坏不该把其余
 * 字段一起打回缺省（那会表现为「改了 A，B 也回到了初始值」）。与 permissions 的
 * tier-store 同一口径（那边是权限档宁严勿松，这边是各字段各自兜底）。
 */

import {
  type VoiceMode,
  type VoiceSelection,
  type VoiceSettings,
  type VoiceSettingsUpdateRequest,
  voiceModeSchema,
  voiceSelectionSchema,
} from "@kenfutwork/shared";

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  // 默认「只转文本」：规划 §4.1 的默认档，模糊语音不会直接起 run
  mode: "transcribe",
  // 三段默认无选择：未选择 = 不下载（规划 §5）。界面据「未选择」引导去下载/选实例
  listen: null,
  think: null,
  speak: null,
  speakReplies: false,
};

function parseSelection(raw: unknown): VoiceSelection | null {
  const parsed = voiceSelectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseMode(raw: unknown): VoiceMode {
  const parsed = voiceModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_VOICE_SETTINGS.mode;
}

/** 库里读回的 jsonb → 设置（坏值逐字段回落缺省）。 */
export function parseVoiceSettings(raw: unknown): VoiceSettings {
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    mode: parseMode(source.mode),
    listen: parseSelection(source.listen),
    think: parseSelection(source.think),
    speak: parseSelection(source.speak),
    speakReplies: source.speakReplies === true,
  };
}

/**
 * 部分更新：只覆盖**显式送来**的字段（未送的一律保持现值）。
 * 逐键判定 `!== undefined` 而不能用 `??`——三段选择允许显式清空（`null`），
 * 用 `??` 会把「清空」当成「没送」。
 */
export function mergeVoiceSettings(
  current: VoiceSettings,
  patch: VoiceSettingsUpdateRequest,
): VoiceSettings {
  return {
    mode: patch.mode ?? current.mode,
    listen: patch.listen === undefined ? current.listen : patch.listen,
    think: patch.think === undefined ? current.think : patch.think,
    speak: patch.speak === undefined ? current.speak : patch.speak,
    speakReplies: patch.speakReplies ?? current.speakReplies,
  };
}
