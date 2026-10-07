import { describe, expect, it } from "vitest";

import {
  DEFAULT_VOICE_SETTINGS,
  mergeVoiceSettings,
  parseVoiceSettings,
} from "./voice-settings.js";

describe("parseVoiceSettings（库读回，逐字段回落）", () => {
  it("null / 非对象 / 空对象一律回缺省（默认档 = 只转文本）", () => {
    expect(parseVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(parseVoiceSettings("nonsense")).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(parseVoiceSettings([1, 2])).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(parseVoiceSettings({})).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(parseVoiceSettings({})).toEqual({
      mode: "transcribe",
      listen: null,
      think: null,
      speak: null,
      speakReplies: false,
    });
  });

  it("一个字段写坏不连坐：坏 mode 回落，好的 listen 照旧保留", () => {
    const parsed = parseVoiceSettings({
      mode: "telepathy",
      listen: { kind: "builtin", id: "sensevoice-small-int8" },
      speakReplies: "yes",
    });
    expect(parsed.mode).toBe("transcribe");
    expect(parsed.listen).toEqual({
      kind: "builtin",
      id: "sensevoice-small-int8",
    });
    // 非布尔真值不当真（宁可当关，也不猜用户意图）
    expect(parsed.speakReplies).toBe(false);
  });

  it("选择形状非法即置 null（不半信半疑地留下半个选择）", () => {
    expect(
      parseVoiceSettings({ listen: { kind: "builtin" } }).listen,
    ).toBeNull();
    expect(parseVoiceSettings({ listen: { id: "x" } }).listen).toBeNull();
    expect(
      parseVoiceSettings({ listen: { kind: "ftp", id: "x" } }).listen,
    ).toBeNull();
    expect(
      parseVoiceSettings({ think: { kind: "instance", id: "i", model: "m" } })
        .think,
    ).toEqual({ kind: "instance", id: "i", model: "m" });
  });

  it("音色与模型原样保留（说段要按音色合成）", () => {
    const parsed = parseVoiceSettings({
      speak: {
        kind: "instance",
        id: "inst-1",
        model: "tts-1",
        voice: "alloy",
      },
    });
    expect(parsed.speak).toEqual({
      kind: "instance",
      id: "inst-1",
      model: "tts-1",
      voice: "alloy",
    });
  });
});

describe("mergeVoiceSettings（部分更新）", () => {
  const current = {
    mode: "loop" as const,
    listen: { kind: "builtin" as const, id: "sensevoice-small-int8" },
    think: { kind: "instance" as const, id: "inst-1", model: "glm" },
    speak: { kind: "instance" as const, id: "inst-1", model: "tts-1" },
    speakReplies: true,
  };

  it("空 patch 原样返回（不把任何设置打回缺省）", () => {
    expect(mergeVoiceSettings(current, {})).toEqual(current);
  });

  it("只改一个键，其余不动", () => {
    const next = mergeVoiceSettings(current, { speakReplies: false });
    expect(next.speakReplies).toBe(false);
    expect(next.mode).toBe("loop");
    expect(next.listen).toEqual(current.listen);
  });

  it("显式 null 是「清空这段选择」，不能被当成「没送」", () => {
    const next = mergeVoiceSettings(current, { listen: null });
    expect(next.listen).toBeNull();
    expect(next.speak).toEqual(current.speak);
  });

  it("false 是有效取值（用 ?? 会把 false 吞掉）", () => {
    const enabled = mergeVoiceSettings(
      { ...current, speakReplies: true },
      {
        speakReplies: false,
      },
    );
    expect(enabled.speakReplies).toBe(false);
  });

  it("把三段全清空：全部变 null（串味检查）", () => {
    const next = mergeVoiceSettings(current, {
      listen: null,
      think: null,
      speak: null,
    });
    expect(next).toEqual({
      mode: "loop",
      listen: null,
      think: null,
      speak: null,
      speakReplies: true,
    });
  });
});
