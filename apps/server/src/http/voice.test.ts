import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { encodeWav, VoiceAudioError } from "../features/voice/audio.js";
import type { VoiceTranscriber } from "../features/voice/types.js";
import { VoiceUnavailableError } from "../features/voice/voice-service.js";
import { registerVoiceRoutes } from "./voice.js";

/**
 * 路由级 inject 回归。锁四件事：
 * 1. 鉴权门（无 token 即 401，不落到服务层）；
 * 2. 音频边界（MIME 白名单、空体、超限）都在**边界**拒绝，且给可读原因；
 * 3. 未装/不可用 → 503 `service_unavailable`（规划 §2.4 的码，不新增）；
 * 4. 部分更新的 PUT 不夹带未送字段（历史事故：默认值把其它设置重置）。
 */

type TranscribeSpy = ReturnType<typeof vi.fn>;

function buildApp(
  options: {
    text?: string;
    unavailable?: string;
    audioError?: string;
    /** 无 token 场景。 */
    unauthenticated?: boolean;
  } = {},
) {
  const transcribeSpy = vi.fn(async () => {
    if (options.audioError) throw new VoiceAudioError(options.audioError);
    return { text: options.text ?? "打开设置页" };
  }) as unknown as TranscribeSpy;
  const transcriber: VoiceTranscriber = {
    ready: async () => ({ ok: true }),
    transcribe: transcribeSpy as unknown as VoiceTranscriber["transcribe"],
  };
  let receivedPatch: unknown = null;
  let receivedSettingsReads = 0;
  const app = Fastify();
  void app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  registerVoiceRoutes(app, {
    auth: {
      authenticate: async () =>
        options.unauthenticated
          ? null
          : {
              accessToken: "tok",
              email: "u@example.com",
              id: "user-1",
              userMetadata: {},
            },
      resolveUser: async () => null,
    } as never,
    viewerService: {
      ensureViewer: async () => ({ workspace: { id: "ws-1" } }),
    } as never,
    voiceService: {
      getSettings: async () => {
        receivedSettingsReads += 1;
        return {
          mode: "transcribe",
          listen: null,
          think: null,
          speak: null,
          speakReplies: false,
        };
      },
      updateSettings: async (_user: unknown, _ws: string, patch: unknown) => {
        receivedPatch = patch;
        return {
          mode: "loop",
          listen: { kind: "builtin", id: "sensevoice-small-int8" },
          think: null,
          speak: null,
          speakReplies: true,
        };
      },
      resolveTranscriber: async () => {
        if (options.unavailable) {
          throw new VoiceUnavailableError(options.unavailable);
        }
        return { impl: transcriber, label: "内置（本机 CPU）" };
      },
    } as never,
  });
  return {
    app,
    transcribeSpy,
    receivedPatch: () => receivedPatch,
    settingsReads: () => receivedSettingsReads,
  };
}

const WAV = encodeWav(new Float32Array(1_600), 16_000);

function audioPayload(bytes: Uint8Array, mimeType = "audio/wav") {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: mimeType }),
    "audio.wav",
  );
  return form;
}

describe("POST /api/voice/transcribe", () => {
  it("正常路径：WAV 进来，文本出去", async () => {
    const { app, transcribeSpy } = buildApp({ text: "把首页按钮改成蓝色" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/transcribe",
        headers: { authorization: "Bearer tok" },
        payload: audioPayload(WAV),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ text: "把首页按钮改成蓝色" });
      expect(transcribeSpy).toHaveBeenCalledTimes(1);
      // 送到 provider 的是**原始字节**（不在这里二次编码）
      const sent = (transcribeSpy.mock.calls[0] as unknown[])[0] as Uint8Array;
      expect(sent.byteLength).toBe(WAV.byteLength);
    } finally {
      await app.close();
    }
  });

  it("空文本是正常结果（用户没说），不是错误", async () => {
    const { app } = buildApp({ text: "" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/transcribe",
        headers: { authorization: "Bearer tok" },
        payload: audioPayload(WAV),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ text: "" });
    } finally {
      await app.close();
    }
  });

  it("无 token：401 且不触达服务层", async () => {
    const { app, transcribeSpy } = buildApp({ unauthenticated: true });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/transcribe",
        payload: audioPayload(WAV),
      });
      expect(response.statusCode).toBe(401);
      expect(transcribeSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("非 WAV 类型：400 invalid_input 且写明只收 WAV", async () => {
    const { app, transcribeSpy } = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/transcribe",
        headers: { authorization: "Bearer tok" },
        payload: audioPayload(WAV, "audio/webm"),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_input");
      expect(response.json().error.message).toContain("WAV");
      expect(transcribeSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("没有 file 字段：400 invalid_input，不落到 provider", async () => {
    const { app, transcribeSpy } = buildApp();
    try {
      const form = new FormData();
      form.append("note", "只是文本");
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/transcribe",
        headers: { authorization: "Bearer tok" },
        payload: form,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_input");
      expect(transcribeSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("空音频：400（不把空体当「没说话」白跑一次识别）", async () => {
    const { app, transcribeSpy } = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/transcribe",
        headers: { authorization: "Bearer tok" },
        payload: audioPayload(new Uint8Array(0)),
      });
      expect(response.statusCode).toBe(400);
      expect(transcribeSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("模型未就绪：503 service_unavailable + 可读原因（不是 500 也不是空 body）", async () => {
    const { app } = buildApp({
      unavailable: "未下载「听」模型（Speech-to-Text）",
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/transcribe",
        headers: { authorization: "Bearer tok" },
        payload: audioPayload(WAV),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("service_unavailable");
      expect(response.json().error.message).toContain("未下载");
    } finally {
      await app.close();
    }
  });

  it("provider 报音频非法：400 invalid_input（VoiceAudioError 映射）", async () => {
    const { app } = buildApp({ audioError: "WAV 数据不完整（文件被截断）。" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/transcribe",
        headers: { authorization: "Bearer tok" },
        payload: audioPayload(WAV),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_input");
      expect(response.json().error.message).toContain("截断");
    } finally {
      await app.close();
    }
  });
});

describe("GET/PUT /api/voice/settings", () => {
  it("GET：读回设置（缺省形状完整，键不缺）", async () => {
    const { app, settingsReads } = buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/voice/settings",
        headers: { authorization: "Bearer tok" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().settings).toEqual({
        mode: "transcribe",
        listen: null,
        think: null,
        speak: null,
        speakReplies: false,
      });
      expect(settingsReads()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("PUT 部分更新：只送 speakReplies 时，patch 里**没有**其它键", async () => {
    const { app, receivedPatch } = buildApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/voice/settings",
        headers: { authorization: "Bearer tok" },
        payload: { speakReplies: true },
      });
      expect(response.statusCode).toBe(200);
      expect(receivedPatch()).toEqual({ speakReplies: true });
    } finally {
      await app.close();
    }
  });

  it("PUT 显式清空某段选择：`null` 必须透传到服务层（不能被当成「没送」）", async () => {
    const { app, receivedPatch } = buildApp();
    try {
      await app.inject({
        method: "PUT",
        url: "/api/voice/settings",
        headers: { authorization: "Bearer tok" },
        payload: { listen: null },
      });
      expect(receivedPatch()).toEqual({ listen: null });
    } finally {
      await app.close();
    }
  });

  it("PUT 非法枚举：400，不写库", async () => {
    const { app, receivedPatch } = buildApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/voice/settings",
        headers: { authorization: "Bearer tok" },
        payload: { mode: "telepathy" },
      });
      expect(response.statusCode).toBe(400);
      expect(receivedPatch()).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("PUT 带完整选择：三段与音色原样透传", async () => {
    const { app, receivedPatch } = buildApp();
    try {
      await app.inject({
        method: "PUT",
        url: "/api/voice/settings",
        headers: { authorization: "Bearer tok" },
        payload: {
          mode: "loop",
          listen: { kind: "instance", id: "inst-1", model: "whisper-1" },
          speak: {
            kind: "instance",
            id: "inst-1",
            model: "tts-1",
            voice: "alloy",
          },
        },
      });
      expect(receivedPatch()).toEqual({
        mode: "loop",
        listen: { kind: "instance", id: "inst-1", model: "whisper-1" },
        speak: {
          kind: "instance",
          id: "inst-1",
          model: "tts-1",
          voice: "alloy",
        },
      });
    } finally {
      await app.close();
    }
  });
});
