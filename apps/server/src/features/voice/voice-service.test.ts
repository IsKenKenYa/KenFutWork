import type { VoiceSelection } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";

import { decodeWav, encodeWav } from "./audio.js";
import { SILERO_VAD_MODEL } from "./catalog.js";
import type { VoiceProvider, VoiceTranscriber } from "./types.js";
import {
  createVoiceService,
  type VoiceServiceDeps,
  VoiceUnavailableError,
} from "./voice-service.js";

/**
 * 解析链路的单测。这里锁的是「**不能静默降级**」那条线：
 * 未选/未下载/实例取不到凭证/协议不支持，四种情形都必须给出可读原因，
 * 而不是回空文本让用户以为「说了没反应」。
 */

const USER = {
  id: "user-1",
  email: "u@example.com",
  accessToken: "tok",
} as never;

function settingsRepo(voice: unknown) {
  let stored: unknown = voice;
  return {
    findVoice: async () => stored,
    upsertVoice: async (_workspaceId: string, next: unknown) => {
      stored = next;
    },
    current: () => stored,
  };
}

function transcriberStub(text = "你好"): VoiceTranscriber {
  return {
    ready: async () => ({ ok: true }),
    transcribe: async () => ({ text }),
  };
}

/** 桩 provider 工厂：记下每次请求的是哪一段。 */
function providerFactory(build: (selection: VoiceSelection) => VoiceProvider) {
  const calls: VoiceSelection[] = [];
  const factory = (selection: VoiceSelection): VoiceProvider => {
    calls.push(selection);
    return build(selection);
  };
  return { factory, calls };
}

function deps(
  overrides: Partial<VoiceServiceDeps> & {
    voice?: unknown;
    createBuiltinProvider?: (selection: VoiceSelection) => VoiceProvider;
  } = {},
): VoiceServiceDeps {
  const { voice = null, ...rest } = overrides;
  return {
    repository: settingsRepo(voice),
    modelsRoot: "/nonexistent/models",
    modelProviders: {
      resolveCredentials: async () => ({
        instanceId: "inst-1",
        name: "我的网关",
        protocol: "openai-compatible",
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-test",
        models: [],
        configRevision: 1,
      }),
    } as never,
    ...rest,
  };
}

describe("voice 服务：听段解析", () => {
  it("未选择「听」模型：可读原因指向设置页（不是「转写失败」这种无用话）", async () => {
    const service = createVoiceService(deps());
    await expect(
      service.resolveTranscriber(USER, "ws-1"),
    ).rejects.toBeInstanceOf(VoiceUnavailableError);
    await expect(service.resolveTranscriber(USER, "ws-1")).rejects.toThrow(
      /未选择「听」模型/,
    );
  });

  it("内置模型 id 认不出：说清可用的是哪个", async () => {
    const service = createVoiceService(
      deps({ voice: { listen: { kind: "builtin", id: "whisper-tiny" } } }),
    );
    await expect(service.resolveTranscriber(USER, "ws-1")).rejects.toThrow(
      /不支持的内置模型：whisper-tiny/,
    );
  });

  it("内置模型 id 非法（越目录）：拒绝，不拼进文件路径", async () => {
    const builtinSpy = vi.fn();
    const service = createVoiceService(
      deps({
        voice: { listen: { kind: "builtin", id: "../../etc/passwd" } },
        createBuiltinProvider: builtinSpy as never,
      }),
    );
    await expect(service.resolveTranscriber(USER, "ws-1")).rejects.toThrow(
      /id 非法/,
    );
    expect(builtinSpy).not.toHaveBeenCalled();
  });

  it("内置模型未下载：原因来自 provider 的 ready（含缺失文件路径）", async () => {
    const { factory } = providerFactory(() => ({
      id: "builtin-sherpa",
      label: "内置（本机 CPU）",
      location: "cpu",
      transcriber: {
        ready: async () => ({
          ok: false,
          reason: "「听」模型文件缺失：/nonexistent/models/x/model.int8.onnx",
        }),
        transcribe: async () => ({ text: "" }),
      },
    }));
    const service = createVoiceService(
      deps({
        voice: { listen: { kind: "builtin", id: "sensevoice-small-int8" } },
        createBuiltinProvider: factory,
      }),
    );
    await expect(service.resolveTranscriber(USER, "ws-1")).rejects.toThrow(
      /模型文件缺失/,
    );
  });

  it("实例选择缺 model：明说「一个实例可能既有转写也有语音模型」", async () => {
    const service = createVoiceService(
      deps({ voice: { listen: { kind: "instance", id: "inst-1" } } }),
    );
    await expect(service.resolveTranscriber(USER, "ws-1")).rejects.toThrow(
      /未指定模型/,
    );
  });

  it("实例凭证取不到：包成可读原因（保留底层信息）", async () => {
    const service = createVoiceService(
      deps({
        voice: {
          listen: { kind: "instance", id: "inst-9", model: "whisper-1" },
        },
        modelProviders: {
          resolveCredentials: async () => {
            throw new Error("Provider instance not found.");
          },
        } as never,
      }),
    );
    await expect(service.resolveTranscriber(USER, "ws-1")).rejects.toThrow(
      /实例不可用.*Provider instance not found/,
    );
  });

  it("实例协议不支持音频：fail loud（不静默回空文本）", async () => {
    const service = createVoiceService(
      deps({
        voice: {
          listen: { kind: "instance", id: "inst-1", model: "whisper-1" },
        },
        modelProviders: {
          resolveCredentials: async () => ({
            instanceId: "inst-1",
            name: "gemini",
            protocol: "gemini",
            apiKey: "k",
            models: [],
            configRevision: 1,
          }),
        } as never,
      }),
    );
    await expect(service.resolveTranscriber(USER, "ws-1")).rejects.toThrow(
      /不支持音频/,
    );
  });

  it("实例可用：走 openai-compatible 适配器，标签取实例端点", async () => {
    const service = createVoiceService(
      deps({
        voice: {
          listen: { kind: "instance", id: "inst-1", model: "whisper-1" },
        },
      }),
    );
    const resolved = await service.resolveTranscriber(USER, "ws-1");
    expect(resolved.impl).toBeDefined();
    expect(resolved.label).toContain("外部端点");
  });
});

describe("voice 服务：Provider 缓存口径", () => {
  it("内置 Provider 缓存：两次解析只构造一次（两百兆模型不能每轮重建）", async () => {
    const { factory, calls } = providerFactory((selection) =>
      selection.id === SILERO_VAD_MODEL.id
        ? {
            id: "vad",
            label: "vad",
            location: "cpu",
            vad: {
              ready: async () => ({
                ok: false,
                reason: "未下载静音检测（VAD）模型",
              }),
              segment: () => ({ segments: [] }),
            },
          }
        : {
            id: "builtin-sherpa",
            label: "内置（本机 CPU）",
            location: "cpu",
            transcriber: transcriberStub(),
          },
    );
    const service = createVoiceService(
      deps({
        voice: { listen: { kind: "builtin", id: "sensevoice-small-int8" } },
        createBuiltinProvider: factory,
      }),
    );
    await service.resolveTranscriber(USER, "ws-1");
    await service.resolveTranscriber(USER, "ws-1");
    // listen 与 vad 各一次：listen 的第二次来自缓存
    expect(calls.filter((c) => c.id === "sensevoice-small-int8")).toHaveLength(
      1,
    );
  });

  it("实例 Provider **不**缓存：凭证每轮重解析（刚改的 Key 不能被吞掉）", async () => {
    const resolveCredentials = vi.fn(async () => ({
      instanceId: "inst-1",
      name: "我的网关",
      protocol: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "sk-test",
      models: [],
      configRevision: 1,
    }));
    const service = createVoiceService(
      deps({
        voice: {
          listen: { kind: "instance", id: "inst-1", model: "whisper-1" },
        },
        modelProviders: { resolveCredentials } as never,
      }),
    );
    await service.resolveTranscriber(USER, "ws-1");
    await service.resolveTranscriber(USER, "ws-1");
    expect(resolveCredentials).toHaveBeenCalledTimes(2);
  });
});

describe("voice 服务：静音掐头去尾（内部优化，不参与可用性判定）", () => {
  function vadProvider(segments: Array<[number, number]>, ready = true) {
    return {
      id: "builtin-sherpa",
      label: "内置（本机 CPU）",
      location: "cpu" as const,
      vad: {
        ready: async () =>
          ready
            ? { ok: true }
            : { ok: false, reason: "未下载静音检测（VAD）模型" },
        segment: () => ({ segments }),
      },
    };
  }

  function listenProvider(spy: ReturnType<typeof vi.fn>) {
    return {
      id: "builtin-sherpa",
      label: "内置（本机 CPU）",
      location: "cpu" as const,
      transcriber: {
        ready: async () => ({ ok: true }),
        transcribe: spy as unknown as VoiceTranscriber["transcribe"],
      },
    };
  }

  it("全段静音：直接回空文本，不白跑一次识别", async () => {
    const spy = vi.fn(async () => ({ text: "谢谢观看" }));
    const service = createVoiceService(
      deps({
        voice: { listen: { kind: "builtin", id: "sensevoice-small-int8" } },
        createBuiltinProvider: (selection) =>
          selection.id === SILERO_VAD_MODEL.id
            ? vadProvider([])
            : listenProvider(spy),
      }),
    );
    const resolved = await service.resolveTranscriber(USER, "ws-1");
    const result = await resolved.impl.transcribe(
      encodeWav(new Float32Array(16_000), 16_000),
    );
    expect(result.text).toBe("");
    expect(spy).not.toHaveBeenCalled();
  });

  it("首尾静音被掐掉：送给识别器的音频变短（且采样率不变）", async () => {
    const spy = vi.fn(async (wav: Uint8Array) => ({
      text: `len=${decodeWav(wav).samples.length}`,
    }));
    const service = createVoiceService(
      deps({
        voice: { listen: { kind: "builtin", id: "sensevoice-small-int8" } },
        createBuiltinProvider: (selection) =>
          selection.id === SILERO_VAD_MODEL.id
            ? // 1 秒素材里只有 0.25s–0.5s 是话音
              vadProvider([[4_000, 8_000]])
            : listenProvider(spy),
      }),
    );
    const resolved = await service.resolveTranscriber(USER, "ws-1");
    const result = await resolved.impl.transcribe(
      encodeWav(new Float32Array(16_000), 16_000),
    );
    expect(result.text).toBe("len=4000");
    expect(
      decodeWav((spy.mock.calls[0] as unknown[])[0] as Uint8Array).sampleRate,
    ).toBe(16_000);
  });

  it("VAD 不可用时照常转写（它是优化，不是能力门禁）", async () => {
    const spy = vi.fn(async () => ({ text: "照常" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = createVoiceService(
      deps({
        voice: { listen: { kind: "builtin", id: "sensevoice-small-int8" } },
        createBuiltinProvider: (selection) =>
          selection.id === SILERO_VAD_MODEL.id
            ? vadProvider([], false)
            : listenProvider(spy),
      }),
    );
    const resolved = await service.resolveTranscriber(USER, "ws-1");
    const result = await resolved.impl.transcribe(
      encodeWav(new Float32Array(1_600), 16_000),
    );
    expect(result.text).toBe("照常");
    // 跳过掐头去尾要留痕，否则「为什么没掐静音」无从排查
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("静音检测不可用"),
    );
    warn.mockRestore();
  });
});

describe("voice 服务：设置读写", () => {
  it("写回时读的是库里的真值（不是「我以为写成了什么」）", async () => {
    const repo = settingsRepo(null);
    const service = createVoiceService({ ...deps(), repository: repo });
    const saved = await service.updateSettings(USER, "ws-1", {
      mode: "loop",
      speakReplies: true,
    });
    expect(saved.mode).toBe("loop");
    expect(saved.speakReplies).toBe(true);
    expect(repo.current()).toMatchObject({ mode: "loop", speakReplies: true });
  });

  it("库里是坏值：读回时逐字段回落，不整块丢弃", async () => {
    const service = createVoiceService(
      deps({
        voice: {
          mode: "loop",
          listen: { kind: "builtin", id: "sensevoice-small-int8" },
          speakReplies: "yes",
        },
      }),
    );
    const settings = await service.getSettings(USER, "ws-1");
    expect(settings.mode).toBe("loop");
    expect(settings.listen).toEqual({
      kind: "builtin",
      id: "sensevoice-small-int8",
    });
    expect(settings.speakReplies).toBe(false);
  });
});

describe("voice 服务：候选目录（三段卡片）", () => {
  function withInstances(
    instances: Array<{
      id: string;
      name: string;
      enabled: boolean;
      models: Array<{
        id: string;
        name: string;
        capability: string;
        enabled?: boolean;
      }>;
    }>,
    modelState?: {
      state: "ready" | "missing" | "downloading";
      downloadedBytes: number;
      totalBytes: number;
    },
  ) {
    return deps({
      modelProviders: { listInstances: async () => instances } as never,
      ...(modelState
        ? {
            modelStore: {
              getState: async () => modelState,
              start: async () => modelState,
              cancel: () => undefined,
              remove: async () => undefined,
            },
          }
        : {}),
    });
  }

  it("内置候选带上体积与下载状态；VAD 不进选择器（它是内部优化）", async () => {
    const service = createVoiceService(
      withInstances([], {
        state: "missing",
        downloadedBytes: 0,
        totalBytes: 239_549_735,
      }),
    );
    const models = await service.listCandidates(USER, "listen");
    expect(models).toHaveLength(1);
    const [builtin] = models;
    expect(builtin?.id).toBe("sensevoice-small-int8");
    expect(builtin?.kind).toBe("builtin");
    expect(builtin?.needsDownload).toBe(true);
    expect(builtin?.sizeBytes).toBeGreaterThan(200 * 1024 * 1024);
    expect(builtin?.download.state).toBe("missing");
    expect(builtin?.license).toBeTruthy();
    expect(models.some((item) => item.id === "silero-vad")).toBe(false);
  });

  it("下载中/就绪的状态原样透出（前端靠它出进度条与删除按钮）", async () => {
    const downloading = createVoiceService(
      withInstances([], {
        state: "downloading",
        downloadedBytes: 1_024,
        totalBytes: 2_048,
      }),
    );
    const [entry] = await downloading.listCandidates(USER, "listen");
    expect(entry?.download).toMatchObject({
      state: "downloading",
      downloadedBytes: 1_024,
    });
  });

  it("实例候选按段取能力：听/说取 audio，想取 chat（一个实例两类都算候选）", async () => {
    const service = createVoiceService(
      withInstances([
        {
          id: "inst-1",
          name: "我的网关",
          enabled: true,
          models: [
            { id: "whisper-1", name: "Whisper", capability: "audio" },
            { id: "tts-1", name: "TTS", capability: "audio" },
            { id: "glm-5", name: "GLM", capability: "chat" },
            { id: "dall-e", name: "DALL·E", capability: "image" },
            {
              id: "off",
              name: "停用模型",
              capability: "audio",
              enabled: false,
            },
          ],
        },
      ]),
    );

    const listen = await service.listCandidates(USER, "listen");
    expect(
      listen
        .filter((item) => item.kind === "instance")
        .map((item) => item.model),
    ).toEqual(["whisper-1", "tts-1"]);
    // image 能力不进语音候选；停用的模型行也不进
    expect(listen.some((item) => item.model === "dall-e")).toBe(false);
    expect(listen.some((item) => item.model === "off")).toBe(false);

    const think = await service.listCandidates(USER, "think");
    expect(
      think
        .filter((item) => item.kind === "instance")
        .map((item) => item.model),
    ).toEqual(["glm-5"]);
    // 想段目前没有内置档（离线 GGUF 需要额外推理运行时，见 catalog 注释）
    expect(think.some((item) => item.kind === "builtin")).toBe(false);
  });

  it("实例停用：候选仍在但带不可选原因（不摆空壳，也不静默消失）", async () => {
    const service = createVoiceService(
      withInstances([
        {
          id: "inst-1",
          name: "停用的网关",
          enabled: false,
          models: [{ id: "whisper-1", name: "Whisper", capability: "audio" }],
        },
      ]),
    );
    const models = await service.listCandidates(USER, "listen");
    // [0] 是内置候选，实例候选要按 kind 找
    const instance = models.find((item) => item.kind === "instance");
    expect(instance?.unavailableReason).toContain("已停用");
    expect(instance?.model).toBe("whisper-1");
  });

  it("实例查询失败：不该把整个目录打崩（回内置候选）", async () => {
    const service = createVoiceService(
      deps({
        modelProviders: {
          listInstances: async () => {
            throw new Error("db down");
          },
        } as never,
      }),
    );
    const models = await service.listCandidates(USER, "listen");
    expect(models.map((item) => item.id)).toEqual(["sensevoice-small-int8"]);
  });
});

describe("voice 服务：真实使用的耗时埋点（规划 §6）", () => {
  /** 一次「说一句」的完整路径：解析 → 转写（含 VAD 包装）。 */
  async function speakOnce(service: ReturnType<typeof createVoiceService>) {
    const resolved = await service.resolveTranscriber(USER, "ws-1");
    return resolved.impl.transcribe(
      encodeWav(new Float32Array(16_000), 16_000),
    );
  }

  function listenProviderStub(elapsedMs: number) {
    return {
      id: "builtin-sherpa",
      label: "内置（本机 CPU）",
      location: "cpu" as const,
      transcriber: {
        ready: async () => ({ ok: true }),
        transcribe: async () => {
          await new Promise((resolve) => setTimeout(resolve, elapsedMs));
          return { text: "你好" };
        },
      },
    };
  }

  function serviceWith(timing: {
    provider: () => ReturnType<typeof listenProviderStub>;
  }) {
    return createVoiceService(
      deps({
        voice: { listen: { kind: "builtin", id: "sensevoice-small-int8" } },
        createBuiltinProvider: (selection) =>
          selection.id === SILERO_VAD_MODEL.id
            ? {
                id: "vad",
                label: "vad",
                location: "cpu",
                vad: {
                  ready: async () => ({
                    ok: false,
                    reason: "未下载静音检测（VAD）模型",
                  }),
                  segment: () => ({ segments: [] }),
                },
              }
            : timing.provider(),
      }),
    );
  }

  it("首次调用只记载入耗时，第二次起进中位实时率（首次不污染统计）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = serviceWith({
      provider: () => listenProviderStub(20),
    });

    expect(service.getListenTimings()).toEqual({ samples: 0 });

    await speakOnce(service);
    const afterFirst = service.getListenTimings();
    // 1 秒音频：首次 20ms 全记在「首次载入」上，不进中位
    expect(afterFirst.samples).toBe(0);
    expect(afterFirst.modelLoadMs).toBeGreaterThanOrEqual(15);
    expect(afterFirst.lastClipSeconds).toBeCloseTo(1, 3);

    await speakOnce(service);
    const afterSecond = service.getListenTimings();
    expect(afterSecond.samples).toBe(1);
    expect(afterSecond.rtfMedian).toBeGreaterThan(0);
    // 载入耗时不因稳态样本出现而丢失
    expect(afterSecond.modelLoadMs).toBe(afterFirst.modelLoadMs);
    warn.mockRestore();
  });

  it("转写失败**不**记读数（失败耗时不是吞吐读数，会把中位数拉成「机器飞快」）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = createVoiceService(
      deps({
        voice: { listen: { kind: "builtin", id: "sensevoice-small-int8" } },
        createBuiltinProvider: (selection) =>
          selection.id === SILERO_VAD_MODEL.id
            ? {
                id: "vad",
                label: "vad",
                location: "cpu",
                vad: {
                  ready: async () => ({ ok: false, reason: "未下载" }),
                  segment: () => ({ segments: [] }),
                },
              }
            : {
                id: "builtin-sherpa",
                label: "内置（本机 CPU）",
                location: "cpu",
                transcriber: {
                  ready: async () => ({ ok: true }),
                  transcribe: async () => {
                    throw new Error("识别器崩了");
                  },
                },
              },
      }),
    );
    await expect(speakOnce(service)).rejects.toThrow(/识别器崩了/);
    expect(service.getListenTimings()).toEqual({ samples: 0 });
    warn.mockRestore();
  });

  it("拿不到音频时长就不记样本（宁缺勿假：编一个实时率比没有读数更坏）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = serviceWith({ provider: () => listenProviderStub(5) });
    const resolved = await service.resolveTranscriber(USER, "ws-1");
    // 桩 provider 不校验音频，所以这里不会抛；关键是**什么也没记**
    await resolved.impl.transcribe(new Uint8Array(120));
    expect(service.getListenTimings()).toEqual({ samples: 0 });
    warn.mockRestore();
  });
});

describe("voice 服务：候选性能标注（规划 §5 预估 → 实测）", () => {
  function withTimings(modelState: "ready" | "missing") {
    return deps({
      modelProviders: { listInstances: async () => [] } as never,
      modelStore: {
        getState: async () => ({
          state: modelState,
          downloadedBytes: modelState === "ready" ? 1 : 0,
          totalBytes: 1,
        }),
        start: async () => ({
          state: "downloading",
          downloadedBytes: 0,
          totalBytes: 1,
        }),
        cancel: () => undefined,
        remove: async () => undefined,
      },
    });
  }

  it("未下载：标「预估」并说明下载后会换成实测", async () => {
    const service = createVoiceService(withTimings("missing"));
    const [candidate] = await service.listCandidates(USER, "listen");
    expect(candidate?.performanceNote).toContain("预估");
    expect(candidate?.performanceNote).toContain("换成实测");
  });

  it("就绪但还没实测：仍标注预估（不编一个实测值出来）", async () => {
    const service = createVoiceService(withTimings("ready"));
    const [candidate] = await service.listCandidates(USER, "listen");
    expect(candidate?.performanceNote).toContain("预估");
  });

  it("就绪 + 有实测：换成实测值，且把首次载入一并写清（别让人以为第一次也这么快）", async () => {
    const service = createVoiceService(
      deps({
        voice: { listen: { kind: "builtin", id: "sensevoice-small-int8" } },
        createBuiltinProvider: (selection) =>
          selection.id === SILERO_VAD_MODEL.id
            ? {
                id: "vad",
                label: "vad",
                location: "cpu",
                vad: {
                  ready: async () => ({ ok: false, reason: "未下载" }),
                  segment: () => ({ segments: [] }),
                },
              }
            : {
                id: "builtin-sherpa",
                label: "内置（本机 CPU）",
                location: "cpu",
                transcriber: {
                  ready: async () => ({ ok: true }),
                  transcribe: async () => ({ text: "你好" }),
                },
              },
        modelProviders: { listInstances: async () => [] } as never,
        modelStore: {
          getState: async () => ({
            state: "ready",
            downloadedBytes: 1,
            totalBytes: 1,
          }),
          start: async () => ({
            state: "downloading",
            downloadedBytes: 0,
            totalBytes: 1,
          }),
          cancel: () => undefined,
          remove: async () => undefined,
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 跑一轮真实转写：首次记 modelLoadMs，第二次进中位
    await service
      .resolveTranscriber(USER, "ws-1")
      .then((r) =>
        r.impl.transcribe(encodeWav(new Float32Array(16_000), 16_000)),
      );
    await service
      .resolveTranscriber(USER, "ws-1")
      .then((r) =>
        r.impl.transcribe(encodeWav(new Float32Array(16_000), 16_000)),
      );

    const [candidate] = await service.listCandidates(USER, "listen");
    expect(candidate?.performanceNote).toContain("实测");
    expect(candidate?.performanceNote).toContain("首次使用另加载");
    expect(candidate?.performanceNote).not.toContain("预估");
    warn.mockRestore();
  });
});
