import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeTestInstance,
  RUNTIME_TEST_ACTOR,
} from "../agent/runtime-test-fixtures.js";

import { encodeWav, VoiceAudioError } from "../features/voice/audio.js";
import { VoiceModelError } from "../features/voice/model-store.js";
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

/** 一份形状合法的检测报告（路由层只做透传与形状校验，判定在前端纯函数里）。 */
const SAMPLE_REPORT = {
  hardware: {
    cpuModel: "Test CPU",
    cpuCores: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    platform: "win32 10.0.26200",
  },
  listen: {
    state: "measured" as const,
    summary: "实测 7 次的中位实时率 0.08。",
    listen: { samples: 7, rtfMedian: 0.081, modelLoadMs: 2_700 },
  },
  think: { state: "unavailable" as const, summary: "未选择「想」模型。" },
  speak: { state: "unavailable" as const, summary: "内置档待定。" },
  measuredAt: "2026-09-26T10:00:00.000Z",
};

function buildApp(
  options: {
    text?: string;
    unavailable?: string;
    audioError?: string;
    /** 无 token 场景。 */
    unauthenticated?: boolean;
    foreignInstance?: boolean;
    /** 挂上模型下载路由（不挂时应为 404）。 */
    withModelStore?: boolean;
    /** start 抛「未知模型」。 */
    unknownModelStart?: boolean;
    /** GET 时读回的上次报告。 */
    lastDiagnose?: unknown;
    /** 自定报告。 */
    report?: unknown;
    /** POST 时抛错。 */
    diagnoseFails?: boolean;
    /** refine 时抛错（未选想模型）。 */
    refineFails?: boolean;
    /** 自定改写结果。 */
    refined?: string;
    /** speak 时抛错（未选说模型）。 */
    speakFails?: boolean;
  } = {},
) {
  let diagnosed = 0;
  const refined: string[] = [];
  const spoken: string[] = [];
  const started: string[] = [];
  const cancelled: string[] = [];
  const removed: string[] = [];
  /** 目录候选：一条内置（未下载）+ 一条实例端点。 */
  const candidates = () => [
    {
      id: "sensevoice-small-int8",
      segment: "listen" as const,
      label: "SenseVoice Small（int8）",
      kind: "builtin" as const,
      location: "cpu" as const,
      sizeBytes: 239_549_735,
      needsDownload: true,
      download: {
        state: "missing" as const,
        downloadedBytes: 0,
        totalBytes: 239_549_735,
      },
      license: "FunASR Model License",
    },
    {
      id: "inst-1",
      segment: "listen" as const,
      label: "我的网关 · whisper-1",
      kind: "instance" as const,
      location: "remote" as const,
      model: "whisper-1",
      sizeBytes: 0,
      needsDownload: false,
      download: { state: "ready" as const, downloadedBytes: 0, totalBytes: 0 },
    },
  ];
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
    localAccess: {
      authenticate: async () =>
        options.unauthenticated
          ? null
          : options.foreignInstance
            ? { ...RUNTIME_TEST_ACTOR, instanceId: "foreign-instance" }
            : RUNTIME_TEST_ACTOR,
    } as never,
    localInstance: createRuntimeTestInstance(),
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
      listCandidates: async () => candidates(),
      resolveSynthesizer: async () => {
        if (options.speakFails) {
          throw new VoiceUnavailableError(
            "未选择「说」模型：到「设置 → 语音」选一个。",
          );
        }
        return {
          impl: {
            ready: async () => ({ ok: true }),
            synthesize: async (text: string) => {
              spoken.push(text);
              return {
                audio: new Uint8Array([82, 73, 70, 70]),
                mimeType: "audio/wav",
              };
            },
          },
          label: "外部端点",
        };
      },
      refine: async (_user: unknown, _ws: string, input: { text: string }) => {
        refined.push(input.text);
        if (options.refineFails) {
          throw new VoiceUnavailableError(
            "未选择「想」模型：完整回路需要一个对话模型。",
          );
        }
        return options.refined ?? "把首页的按钮改成蓝色，改完能在页面上看到。";
      },
      getListenTimings: () => ({
        rtfMedian: 0.081,
        samples: 7,
        modelLoadMs: 2_700,
        lastClipSeconds: 3.21,
      }),
      getLastDiagnose: () => options.lastDiagnose ?? null,
      diagnose: async () => {
        diagnosed += 1;
        if (options.diagnoseFails) {
          throw new VoiceUnavailableError("检测失败（测试）");
        }
        return options.report ?? SAMPLE_REPORT;
      },
    } as never,
    ...(options.withModelStore
      ? {
          modelStore: {
            getState: async () => ({
              state: "missing" as const,
              downloadedBytes: 0,
              totalBytes: 1_024,
            }),
            start: async (modelId: string) => {
              started.push(modelId);
              if (options.unknownModelStart) {
                throw new VoiceModelError(`未知的内置模型：${modelId}`);
              }
              return {
                state: "downloading" as const,
                downloadedBytes: 0,
                totalBytes: 1_024,
              };
            },
            cancel: (modelId: string) => {
              cancelled.push(modelId);
            },
            remove: async (modelId: string) => {
              removed.push(modelId);
            },
          },
        }
      : {}),
  });
  return {
    app,
    transcribeSpy,
    receivedPatch: () => receivedPatch,
    settingsReads: () => receivedSettingsReads,
    started,
    cancelled,
    removed,
    diagnosed: () => diagnosed,
    refined,
    spoken,
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

describe("/api/voice/models（目录 / 下载 / 取消 / 删除）", () => {
  it("未挂下载器时整组路由不存在（404，而不是会炸的假接口）", async () => {
    const { app } = buildApp();
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/voice/models" }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/voice/models/sensevoice-small-int8/download",
            headers: { authorization: "Bearer tok" },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("GET 目录：内置候选带下载状态与体积，实例候选标记零下载", async () => {
    const { app } = buildApp({ withModelStore: true });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/voice/models",
        headers: { authorization: "Bearer tok" },
      });
      expect(response.statusCode).toBe(200);
      const models = response.json().models as Array<Record<string, unknown>>;
      expect(models).toHaveLength(2);
      const builtin = models.find((item) => item.kind === "builtin");
      expect(builtin?.sizeBytes).toBeGreaterThan(0);
      expect(builtin?.needsDownload).toBe(true);
      expect(builtin?.download).toMatchObject({ state: "missing" });
      const instance = models.find((item) => item.kind === "instance");
      expect(instance?.needsDownload).toBe(false);
      expect(instance?.model).toBe("whisper-1");
    } finally {
      await app.close();
    }
  });

  it("POST 下载：202 + 状态，且真的调了 store", async () => {
    const { app, started } = buildApp({ withModelStore: true });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/models/sensevoice-small-int8/download",
        headers: { authorization: "Bearer tok" },
      });
      expect(response.statusCode).toBe(202);
      expect(started).toEqual(["sensevoice-small-int8"]);
      expect(response.json().model.id).toBe("sensevoice-small-int8");
    } finally {
      await app.close();
    }
  });

  it("POST 未知模型：400 invalid_input（store 的拒绝原样透出，不变成 500）", async () => {
    const { app } = buildApp({
      withModelStore: true,
      unknownModelStart: true,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/models/ghost/download",
        headers: { authorization: "Bearer tok" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_input");
      expect(response.json().error.message).toContain("未知的内置模型");
    } finally {
      await app.close();
    }
  });

  it("DELETE 下载：取消；DELETE 模型：删除（两条路径各自落到 store）", async () => {
    const { app, cancelled, removed } = buildApp({ withModelStore: true });
    try {
      const cancel = await app.inject({
        method: "DELETE",
        url: "/api/voice/models/sensevoice-small-int8/download",
        headers: { authorization: "Bearer tok" },
      });
      expect(cancel.statusCode).toBe(200);
      expect(cancelled).toEqual(["sensevoice-small-int8"]);

      const remove = await app.inject({
        method: "DELETE",
        url: "/api/voice/models/sensevoice-small-int8",
        headers: { authorization: "Bearer tok" },
      });
      expect(remove.statusCode).toBe(200);
      expect(removed).toEqual(["sensevoice-small-int8"]);
    } finally {
      await app.close();
    }
  });

  it("实例候选不能被当内置模型下载（findCandidate 只认 builtin）", async () => {
    const { app, started } = buildApp({ withModelStore: true });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/models/inst-1/download",
        headers: { authorization: "Bearer tok" },
      });
      // store 先拒（未知内置模型），故 400；无论如何都不会去动实例
      expect(response.statusCode).toBe(400);
      expect(started).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("模型路由同样要鉴权（无 token 401，不触达 store）", async () => {
    const { app, started, removed } = buildApp({
      withModelStore: true,
      unauthenticated: true,
    });
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/voice/models" }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/voice/models/sensevoice-small-int8/download",
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: "/api/voice/models/sensevoice-small-int8",
          })
        ).statusCode,
      ).toBe(401);
      expect(started).toEqual([]);
      expect(removed).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("/api/voice/diagnose（性能检测）", () => {
  it("GET 读回上次报告；没测过时 report 为 null（不给空壳对象）", async () => {
    const empty = buildApp();
    const saved = buildApp({ lastDiagnose: SAMPLE_REPORT });
    try {
      const none = await empty.app.inject({
        method: "GET",
        url: "/api/voice/diagnose",
        headers: { authorization: "Bearer tok" },
      });
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ report: null });
      expect(empty.diagnosed()).toBe(0);

      const loaded = await saved.app.inject({
        method: "GET",
        url: "/api/voice/diagnose",
        headers: { authorization: "Bearer tok" },
      });
      expect(loaded.json().report.hardware.cpuCores).toBe(8);
      expect(loaded.json().report.listen.listen.rtfMedian).toBe(0.081);
      // GET 不该触发重新检测（检测要钱要时间，必须是显式动作）
      expect(saved.diagnosed()).toBe(0);
    } finally {
      await empty.app.close();
      await saved.app.close();
    }
  });

  it("POST 跑一次检测并回报告", async () => {
    const { app, diagnosed } = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/diagnose",
        headers: { authorization: "Bearer tok" },
      });
      expect(response.statusCode).toBe(200);
      expect(diagnosed()).toBe(1);
      expect(response.json().report.measuredAt).toBe(
        "2026-09-26T10:00:00.000Z",
      );
    } finally {
      await app.close();
    }
  });

  it("POST 检测失败：503 + 可读原因（不是 500 空白）", async () => {
    const { app } = buildApp({ diagnoseFails: true });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/diagnose",
        headers: { authorization: "Bearer tok" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.message).toContain("检测失败");
    } finally {
      await app.close();
    }
  });

  it("两条路由都要鉴权（无 token 401，不触达服务层）", async () => {
    const { app, diagnosed } = buildApp({ unauthenticated: true });
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/voice/diagnose" }))
          .statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ method: "POST", url: "/api/voice/diagnose" }))
          .statusCode,
      ).toBe(401);
      expect(diagnosed()).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/voice/refine（想段：口述 → 完整需求）", () => {
  it("正常路径：口述进来，完整需求出去；上下文条数与上限都按契约校验", async () => {
    const { app, refined } = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/refine",
        headers: { authorization: "Bearer tok" },
        payload: {
          text: "那个按钮改成蓝的",
          recentMessages: [
            { role: "user", content: "首页要加一个按钮" },
            { role: "assistant", content: "好的，加在右上角" },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().prompt).toContain("蓝色");
      expect(refined).toEqual(["那个按钮改成蓝的"]);
    } finally {
      await app.close();
    }
  });

  it("未选「想」模型：503 service_unavailable + 指向设置页的可读原因", async () => {
    const { app } = buildApp({ refineFails: true });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/refine",
        headers: { authorization: "Bearer tok" },
        payload: { text: "改蓝" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("service_unavailable");
      expect(response.json().error.message).toContain("未选择「想」模型");
    } finally {
      await app.close();
    }
  });

  it("上下文超上限或空文本：400 invalid_input（契约挡住，不落到服务层）", async () => {
    const { app, refined } = buildApp();
    try {
      const tooMany = await app.inject({
        method: "POST",
        url: "/api/voice/refine",
        headers: { authorization: "Bearer tok" },
        payload: {
          text: "改蓝",
          recentMessages: Array.from({ length: 7 }, () => ({
            role: "user",
            content: "x",
          })),
        },
      });
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json().error.code).toBe("invalid_input");

      const empty = await app.inject({
        method: "POST",
        url: "/api/voice/refine",
        headers: { authorization: "Bearer tok" },
        payload: { text: "" },
      });
      expect(empty.statusCode).toBe(400);
      expect(refined).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("无 token：401 且不触达服务层", async () => {
    const { app, refined } = buildApp({ unauthenticated: true });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/refine",
        payload: { text: "改蓝" },
      });
      expect(response.statusCode).toBe(401);
      expect(refined).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/voice/speak（说段：回复播报）", () => {
  it("回的是**音频字节**（不是 JSON），content-type 取 provider 给的值", async () => {
    const { app, spoken } = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/speak",
        headers: { authorization: "Bearer tok" },
        payload: { text: "已经改好了" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("audio/wav");
      // 不缓存：播报内容每次都是新的，缓存住会念上一句
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(Array.from(response.rawPayload)).toEqual([82, 73, 70, 70]);
      expect(spoken).toEqual(["已经改好了"]);
    } finally {
      await app.close();
    }
  });

  it("未选「说」模型：503 + 指向设置页的原因", async () => {
    const { app } = buildApp({ speakFails: true });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/speak",
        headers: { authorization: "Bearer tok" },
        payload: { text: "念一句" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.message).toContain("未选择「说」模型");
    } finally {
      await app.close();
    }
  });

  it("空文本：400（不打端点）；无 token：401", async () => {
    const { app, spoken } = buildApp();
    const anon = buildApp({ unauthenticated: true });
    try {
      const empty = await app.inject({
        method: "POST",
        url: "/api/voice/speak",
        headers: { authorization: "Bearer tok" },
        payload: { text: "" },
      });
      expect(empty.statusCode).toBe(400);
      expect(spoken).toEqual([]);

      const unauthorized = await anon.app.inject({
        method: "POST",
        url: "/api/voice/speak",
        payload: { text: "念一句" },
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(anon.spoken).toEqual([]);
    } finally {
      await app.close();
      await anon.app.close();
    }
  });
});

describe("voice 本机归属", () => {
  it("错误实例在读取语音设置前被拒绝", async () => {
    const fixture = buildApp({ foreignInstance: true });
    try {
      const response = await fixture.app.inject({ url: "/api/voice/settings" });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("instance_forbidden");
    } finally {
      await fixture.app.close();
    }
  });
});
