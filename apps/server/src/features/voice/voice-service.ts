/**
 * voice 服务（规划 §2.1–§2.3 的 Service Provider 组装点）：把「听 / 想 / 说」三段
 * 按工作区设置解析成具体 Provider，交给 HTTP 消费方。
 *
 * 缓存口径（**别改**，改错会以「每次录音卡十几秒」的形式暴露）：
 * - **内置** Provider 按模型配置缓存：它握着 sherpa 的模型实例（两百兆级），每次请求
 *   重建等于每轮重新加载模型；
 * - **实例** Provider 每次重建：它只是个 fetch 包装（构造成本可忽略），而凭证与模型
 *   可能刚被用户改过，缓存会把改动静默吞掉。
 */

import { join } from "node:path";
import type {
  VoiceDiagnoseHardware,
  VoiceDiagnoseReport,
  VoiceModelCandidate,
  VoiceRefineContextMessage,
  VoiceSelection,
  VoiceSettings,
  VoiceSettingsUpdateRequest,
} from "@kenfutwork/shared";
import { voiceDiagnoseReportSchema } from "@kenfutwork/shared";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  resolveInstanceAudioProvider,
  resolveInstanceChatModel,
} from "../../providers/resolve.js";

import type { LocalActor } from "../local-instance/types.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import {
  decodeWav,
  encodeWav,
  floatToPcm16Array,
  probeWav,
  resampleLinear,
  VOICE_SAMPLE_RATE,
} from "./audio.js";
import {
  isValidBuiltinModelId,
  resolveBuiltinModelDir,
} from "./builtin-models.js";
import {
  BUILTIN_VOICE_MODELS,
  builtinModelSizeBytes,
  findBuiltinModel,
  SILERO_VAD_MODEL,
} from "./catalog.js";
import {
  buildReport,
  collectHardware,
  listenSegment,
  realtimeMultiple,
  speakSegment,
  thinkSegment,
} from "./diagnose.js";
import type { VoiceModelStore } from "./model-store.js";
import {
  createLlamafileThinkProvider,
  type LlamafileThinkProvider,
} from "./providers/llamafile.js";
import { createSherpaProvider, type SherpaModels } from "./providers/sherpa.js";
import { REFINE_SYSTEM_PROMPT } from "./refine-prompt.js";
import type { VoiceDiagnoseStore, VoiceRepository } from "./repository.js";
import {
  createVoiceTimingLog,
  type VoiceListenSummary,
  type VoiceTimingLog,
} from "./timing-log.js";
import type {
  VoiceActivityDetector,
  VoiceProvider,
  VoiceSynthesizer,
  VoiceTranscriber,
} from "./types.js";
import {
  DEFAULT_VOICE_SETTINGS,
  mergeVoiceSettings,
  parseVoiceSettings,
} from "./voice-settings.js";

/** 能力不可用（模型未下载 / 端点未配 / 凭据取不到）：HTTP 层映射成 503。 */
export class VoiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceUnavailableError";
  }
}

export interface ResolvedSegment<T> {
  impl: T;
  /** 供日志与检测报告显示的可读标识（如「内置（本机 CPU）」）。 */
  label: string;
}

export interface VoiceServiceDeps {
  repository: VoiceRepository;
  modelProviders: ModelProviderService;
  /** 内置模型根目录（`~/.kenfutwork/models` 或桌面数据目录下）。 */
  modelsRoot: string;
  /** 内置模型下载状态（候选卡片要显示「未下载 / 下载中 / 就绪」）。 */
  modelStore?: VoiceModelStore;
  /** 检测报告的持久化（app_config 单行；缺席 = 只测不存）。 */
  diagnoseStore?: VoiceDiagnoseStore;
  /** 测试注入：内置 Provider 工厂（默认走 sherpa）。 */
  createBuiltinProvider?: (selection: VoiceSelection) => VoiceProvider;
  /** 测试注入：硬件探测（默认读 os + nvidia-smi）。 */
  collectHardware?: () => Promise<VoiceDiagnoseHardware>;
  /** 测试注入：想段改写（默认打用户的 BYOK 对话模型）。 */
  refine?: (
    user: LocalActor,
    selection: VoiceSelection,
    input: { text: string; recentMessages?: VoiceRefineContextMessage[] },
    signal?: AbortSignal,
  ) => Promise<string>;
  /** 测试注入：想段 TTFT 探针（默认打用户的 BYOK 对话模型）。 */
  probeThink?: (
    user: LocalActor,
    selection: VoiceSelection,
    signal?: AbortSignal,
  ) => Promise<{ ttftSeconds: number; tokensPerSecond?: number }>;
  /** 测试注入：离线「想」档 provider（默认走 llamafile）。 */
  createThinkProvider?: (selection: VoiceSelection) => LlamafileThinkProvider;
}

export interface VoiceService {
  getSettings(user: LocalActor, instanceId: string): Promise<VoiceSettings>;
  updateSettings(
    user: LocalActor,
    instanceId: string,
    patch: VoiceSettingsUpdateRequest,
  ): Promise<VoiceSettings>;
  /** 解析「听」段；未就绪即抛 `VoiceUnavailableError`（可读原因）。 */
  resolveTranscriber(
    user: LocalActor,
    instanceId: string,
  ): Promise<ResolvedSegment<VoiceTranscriber>>;
  /**
   * 三段的候选卡片（规划 §5）：内置离线模型（含下载状态）+ 该用户自己的音频/对话
   * 模型实例。**只列真能用的**：不可用的带 `unavailableReason` 置灰并写明原因。
   */
  listCandidates(
    user: LocalActor,
    segment?: "listen" | "think" | "speak",
  ): Promise<VoiceModelCandidate[]>;
  /**
   * 「想」段：把口述补成完整需求（规划 §4.2）。
   * 未选/不可用即抛 `VoiceUnavailableError`（可读原因），**不静默回原文本**——
   * 静默回落会让用户以为模型改写过，实际什么都没发生。
   */
  refine(
    user: LocalActor,
    instanceId: string,
    input: { text: string; recentMessages?: VoiceRefineContextMessage[] },
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * 解析「说」段；未就绪即抛 `VoiceUnavailableError`（可读原因）。
   * 当前只有 BYOK 端点档（内置档待定，见 catalog 注释）。
   */
  resolveSynthesizer(
    user: LocalActor,
    instanceId: string,
  ): Promise<ResolvedSegment<VoiceSynthesizer>>;
  /** 真实使用的「听」实测汇总（检测页与检测报告共用）。 */
  getListenTimings(): VoiceListenSummary;
  /** 上次检测报告（启动期读回的那份；没测过回 null）。 */
  getLastDiagnose(): VoiceDiagnoseReport | null;
  /** 跑一次检测并持久化（规划 §6）。 */
  diagnose(
    user: LocalActor,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<VoiceDiagnoseReport>;
}

export function createVoiceService(deps: VoiceServiceDeps): VoiceService {
  /** 内置 Provider 缓存（键 = 选择的三段文件集合；见文件头的缓存口径）。 */
  const builtinCache = new Map<string, VoiceProvider>();
  /** 真实使用耗时（只记时长，不记音频与文本）。 */
  const timingLog = createVoiceTimingLog();
  /** 已经出过首次调用的 provider（用来把「模型载入」从中位 RTF 里单列）。 */
  const warmedProviders = new Set<string>();
  /** 各 provider 的首次载入耗时（首次实测后一直复用：它不会因为热启动而消失）。 */
  const modelLoadMsByProvider = new Map<string, number>();
  /** 上次检测报告（启动期读回；没测过为 null）。 */
  let lastDiagnose: VoiceDiagnoseReport | null = null;

  function builtinProvider(selection: VoiceSelection): VoiceProvider {
    const key = `${selection.kind}:${selection.id}`;
    const cached = builtinCache.get(key);
    if (cached) {
      return cached;
    }
    const provider =
      deps.createBuiltinProvider?.(selection) ??
      createBuiltinProviderFromModelsRoot(deps.modelsRoot, selection);
    builtinCache.set(key, provider);
    return provider;
  }

  async function readSettings(
    actor: LocalActor,
    instanceId: string,
  ): Promise<VoiceSettings> {
    if (actor.instanceId !== instanceId) {
      throw new VoiceUnavailableError("语音设置不属于当前本地实例。");
    }
    const raw = await deps.repository.findVoice(instanceId);
    return raw === null ? DEFAULT_VOICE_SETTINGS : parseVoiceSettings(raw);
  }

  /** 内置段：目录 id 认不出/文件缺失都走这里给可读原因。 */
  function requireBuiltin(
    selection: VoiceSelection,
    segment: "listen" | "speak",
    segmentLabel: string,
  ): VoiceProvider {
    if (!isValidBuiltinModelId(selection.id)) {
      throw new VoiceUnavailableError(
        `「${segmentLabel}」选择的内置模型 id 非法：${selection.id}`,
      );
    }
    const builtin = findBuiltinModel(selection.id);
    if (!builtin || builtin.segment !== segment) {
      const available = BUILTIN_VOICE_MODELS.filter(
        (model) => model.segment === segment,
      )
        .map((model) => model.id)
        .join("、");
      throw new VoiceUnavailableError(
        `「${segmentLabel}」不支持的内置模型：${selection.id}${
          available ? `（可用：${available}）` : "（该段目前没有内置模型）"
        }`,
      );
    }
    return builtinProvider(selection);
  }

  /** 实例段：按**本地实例作用域**解析凭证（不是 worker 的 resolveCredentialsById）。 */
  async function instanceProvider(
    user: LocalActor,
    selection: VoiceSelection,
    segmentLabel: string,
  ): Promise<VoiceProvider> {
    if (!selection.model) {
      throw new VoiceUnavailableError(
        `「${segmentLabel}」的供应商实例未指定模型（一个实例可能既有转写也有语音模型）。`,
      );
    }
    const credentials = await deps.modelProviders
      .resolveCredentials(user, selection.id)
      .catch((error: unknown) => {
        throw new VoiceUnavailableError(
          `「${segmentLabel}」的供应商实例不可用：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    const provider = resolveInstanceAudioProvider(credentials.protocol, {
      credentials: {
        apiKey: credentials.apiKey,
        ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
        ...(credentials.headers ? { headers: credentials.headers } : {}),
      },
      transcribeModel: selection.model,
    });
    return provider;
  }

  async function resolveProvider(
    user: LocalActor,
    selection: VoiceSelection | null,
    segment: "listen" | "speak",
    segmentLabel: string,
  ): Promise<VoiceProvider> {
    if (!selection) {
      throw new VoiceUnavailableError(
        `未选择「${segmentLabel}」模型。到「设置 → 语音」选一个（内置模型需先下载）。`,
      );
    }
    return selection.kind === "builtin"
      ? requireBuiltin(selection, segment, segmentLabel)
      : await instanceProvider(user, selection, segmentLabel);
  }

  /**
   * 启动期读回上次报告（读失败只是没有历史，不影响功能——检测结果不是必需能力）。
   * 不 await：装配不该被一次读库拖住；报告晚几百毫秒可见无影响。
   */
  void (async () => {
    if (!deps.diagnoseStore) {
      return;
    }
    try {
      const parsed = voiceDiagnoseReportSchema.safeParse(
        await deps.diagnoseStore.load(),
      );
      lastDiagnose = parsed.success ? parsed.data : null;
    } catch (error) {
      console.warn(
        "[voice] 检测报告读回失败（当作没测过）：",
        error instanceof Error ? error.message : String(error),
      );
      lastDiagnose = null;
    }
  })();

  return {
    getSettings(user, instanceId) {
      return readSettings(user, instanceId);
    },

    async updateSettings(user, instanceId, patch) {
      const current = await readSettings(user, instanceId);
      const next = mergeVoiceSettings(current, patch);
      // 先写库再返回：读回的是库里的事实，不是「我以为写成了什么」
      await deps.repository.upsertVoice(instanceId, next);
      return parseVoiceSettings(await deps.repository.findVoice(instanceId));
    },

    async resolveTranscriber(user, instanceId) {
      const settings = await readSettings(user, instanceId);
      const providerKey = settings.listen
        ? `${settings.listen.kind}:${settings.listen.id}`
        : "none";
      const provider = await resolveProvider(
        user,
        settings.listen,
        "listen",
        "听",
      );
      const transcriber = provider.transcriber;
      if (!transcriber) {
        throw new VoiceUnavailableError(
          `所选「听」模型不提供转写能力（${provider.label}）。`,
        );
      }
      const verdict = await transcriber.ready();
      if (!verdict.ok) {
        throw new VoiceUnavailableError(verdict.reason ?? "「听」模型不可用。");
      }
      const vad = await resolveVad();
      const instrumented = withTranscriptionTiming(
        vad ? withSilenceTrim(transcriber, vad) : transcriber,
        () => {
          // 首次调用含模型载入：单列成 modelLoadMs，不污染中位 RTF
          const cold = !warmedProviders.has(providerKey);
          warmedProviders.add(providerKey);
          return cold;
        },
        timingLog,
      );
      return { impl: instrumented, label: provider.label };
    },

    async listCandidates(user, segment) {
      const targets: Array<"listen" | "think" | "speak"> = segment
        ? [segment]
        : ["listen", "think", "speak"];

      // 内置离线模型：只列与目标段匹配的（VAD 是内部优化，不进选择器）
      const builtin: VoiceModelCandidate[] = [];
      /** 真实使用的实测汇总：就绪的模型据此把「预估」换成实测（规划 §5）。 */
      const measured = timingLog.summary();
      for (const model of BUILTIN_VOICE_MODELS) {
        if (model.segment === "vad" || !targets.includes(model.segment)) {
          continue;
        }
        const sizeBytes = builtinModelSizeBytes(model);
        const state = await deps.modelStore?.getState(model.id);
        const ready = state?.state === "ready";
        builtin.push({
          id: model.id,
          segment: model.segment,
          label: model.label,
          kind: "builtin",
          location: "cpu",
          sizeBytes,
          needsDownload: true,
          download: {
            state: state?.state ?? "missing",
            downloadedBytes: state?.downloadedBytes ?? 0,
            totalBytes: state?.totalBytes ?? sizeBytes,
            ...(state?.error ? { error: state.error } : {}),
          },
          /**
           * 规划 §5：未下载只给**标着「预估」**的值；下载并实测后换成实测值。
           * 文案口径（用户口径 2026-09-27）：**只给数字**，不写句子——界面负责排版，
           * 解释留在文档里。首次调用含模型载入，故实测值后面跟一个「首载」，别让人
           * 以为第一次也这么快。
           *
           * 「想」段单独一套口径：它的量纲是 tok/s（不是 ASR 的 RTF 倍数），未下载时给
           * 规划 §3.2 的推算值并标「预估」；就绪后不编数字（真实吞吐要经检测页量，
           * 没量到就不写——运行位置已经由 `location` 说明）。
           */
          ...(model.segment === "think"
            ? ready
              ? {}
              : { performanceNote: "预估 10–20 tokens/s" }
            : {
                performanceNote:
                  ready && measured.rtfMedian !== undefined
                    ? `实测 ${realtimeMultiple(measured.rtfMedian)}${
                        measured.modelLoadMs === undefined
                          ? ""
                          : ` 首载 ${(measured.modelLoadMs / 1000).toFixed(1)}s`
                      }`
                    : "预估 比实时快 1.4–10 倍",
              }),
          license: model.license,
        });
      }

      /**
       * 实例候选（零下载的在线档）：听/说用 `audio` 能力的模型，想用 `chat` 模型
       * ——一个实例可能两类都有（whisper-1 与 tts-1 各算一条候选）。
       */
      const instances = await deps.modelProviders
        .listInstances(user)
        .catch(() => []);
      const instanceCandidates: VoiceModelCandidate[] = [];
      for (const target of targets) {
        const capability = target === "think" ? "chat" : "audio";
        for (const instance of instances) {
          for (const model of instance.models) {
            if (model.enabled === false || model.capability !== capability) {
              continue;
            }
            instanceCandidates.push({
              id: instance.id,
              segment: target,
              label: `${instance.name} / ${model.name}`,
              kind: "instance",
              location: "remote",
              model: model.id,
              sizeBytes: 0,
              needsDownload: false,
              download: {
                state: "ready",
                downloadedBytes: 0,
                totalBytes: 0,
              },
              performanceNote: "端点延迟",
              ...(instance.enabled
                ? {}
                : { unavailableReason: "该供应商实例已停用" }),
            });
          }
        }
      }

      return [...builtin, ...instanceCandidates];
    },

    async refine(user, instanceId, input, signal) {
      const settings = await readSettings(user, instanceId);
      if (!settings.think) {
        throw new VoiceUnavailableError(
          "未选择「想」模型：完整回路需要一个对话模型（到「设置 → 语音」选一个）。",
        );
      }
      if (settings.think.kind === "builtin") {
        // 离线档：llamafile（权重 + 运行时同一文件，按需下载；见 providers/llamafile.ts）
        const model = findBuiltinModel(settings.think.id);
        if (!model || model.segment !== "think") {
          throw new VoiceUnavailableError(
            `内置「想」模型不存在：${settings.think.id}（到「设置 → 语音」重新选择）。`,
          );
        }
        const provider = (
          deps.createThinkProvider ?? defaultThinkProvider(deps)
        )(settings.think);
        const ready = await provider.ready();
        if (!ready.ok) {
          throw new VoiceUnavailableError(
            ready.reason ?? "离线「想」模型未就绪。",
          );
        }
        try {
          return await provider.refine(input, signal);
        } catch (error) {
          throw new VoiceUnavailableError(
            error instanceof Error ? error.message : "离线「想」模型调用失败。",
          );
        }
      }
      const run = deps.refine ?? refineWithInstanceChat(deps);
      return run(user, settings.think, input, signal);
    },

    async resolveSynthesizer(user, instanceId) {
      const settings = await readSettings(user, instanceId);
      const selection = settings.speak;
      if (!selection) {
        throw new VoiceUnavailableError(
          "未选择「说」模型：到「设置 → 语音」选一个（当前只支持 BYOK 语音端点）。",
        );
      }
      if (selection.kind === "builtin") {
        const provider = requireBuiltin(selection, "speak", "说");
        const synthesizer = provider.synthesizer;
        if (!synthesizer) {
          throw new VoiceUnavailableError("所选「说」模型不提供合成能力。");
        }
        const verdict = await synthesizer.ready();
        if (!verdict.ok) {
          throw new VoiceUnavailableError(
            verdict.reason ?? "「说」模型不可用。",
          );
        }
        return { impl: synthesizer, label: provider.label };
      }
      if (!selection.model) {
        throw new VoiceUnavailableError(
          "「说」的供应商实例未指定模型（一个实例可能既有转写也有语音模型）。",
        );
      }
      const credentials = await deps.modelProviders
        .resolveCredentials(user, selection.id)
        .catch((error: unknown) => {
          throw new VoiceUnavailableError(
            `「说」的供应商实例不可用：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      const provider = resolveInstanceAudioProvider(credentials.protocol, {
        credentials: {
          apiKey: credentials.apiKey,
          ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
          ...(credentials.headers ? { headers: credentials.headers } : {}),
        },
        speechModel: selection.model,
        ...(selection.voice ? { voice: selection.voice } : {}),
      });
      const synthesizer = provider.synthesizer;
      if (!synthesizer) {
        throw new VoiceUnavailableError(
          `所选「说」模型不提供合成能力（${provider.label}）。`,
        );
      }
      const verdict = await synthesizer.ready();
      if (!verdict.ok) {
        throw new VoiceUnavailableError(verdict.reason ?? "「说」模型不可用。");
      }
      return { impl: synthesizer, label: provider.label };
    },

    getListenTimings() {
      return timingLog.summary();
    },

    getLastDiagnose() {
      return lastDiagnose;
    },

    async diagnose(user, instanceId, signal) {
      const settings = await readSettings(user, instanceId);
      const hardware = await (deps.collectHardware ?? collectHardware)();

      // 说：现场合成一句固定短句，量首包与实时率（规划 §6）。
      // 这段音频由神经网络 TTS 真念出来，因此**顺带给「听」当探针音频**——「听」不必
      // 再等用户真说过一句话才有读数（见文件末 measureListenPerformance 的注释）。
      let speakMeasurement:
        | { firstByteSeconds: number; rtf: number }
        | undefined;
      let speakReason: string | undefined;
      let probeAudio: Uint8Array | undefined;
      if (!settings.speak) {
        speakReason = "未选择「说」模型：到「设置 → 语音」选一个。";
      } else {
        const probeText = "这是一次语音合成检测。";
        try {
          const { impl: synthesizer } = await this.resolveSynthesizer(
            user,
            instanceId,
          );
          const started = Date.now();
          const { audio } = await synthesizer.synthesize(probeText, {
            ...(signal ? { signal } : {}),
          });
          const elapsedSeconds = (Date.now() - started) / 1000;
          // 内置路径是「一次性合成整段」，首包≈总耗时；按 WAV 头算音频时长得实时率
          const audioSeconds = wavSeconds(audio);
          speakMeasurement = {
            firstByteSeconds: elapsedSeconds,
            rtf:
              audioSeconds > 0 ? elapsedSeconds / audioSeconds : elapsedSeconds,
          };
          if (audioSeconds > 0) {
            probeAudio = normalizeProbeAudio(audio);
          }
        } catch (error) {
          speakReason = `「说」段检测失败：${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      // 听：优先用探针音频现场实测（冷启动单列载入耗时）；拿不到探针音频
      // （未选/未下载「说」模型）才回退到真实使用的统计。
      let listenSummary = timingLog.summary();
      let listenReason: string | undefined;
      let listenProbeError: string | undefined;
      if (!settings.listen) {
        listenReason =
          "未选择「听」模型：到「设置 → 语音」选一个（内置模型需先下载）。";
      } else {
        const selection = settings.listen;
        const provider = await resolveProvider(
          user,
          selection,
          "listen",
          "听",
        ).catch((error: unknown) => {
          listenReason = error instanceof Error ? error.message : String(error);
          return undefined;
        });
        const transcriber = provider?.transcriber;
        if (provider && !transcriber) {
          listenReason = `所选「听」模型不提供转写能力（${provider.label}）。`;
        } else if (transcriber) {
          const verdict = await transcriber.ready().catch((error: unknown) => ({
            ok: false as const,
            reason: error instanceof Error ? error.message : String(error),
          }));
          if (!verdict.ok) {
            listenReason = verdict.reason ?? "「听」模型不可用。";
          } else if (probeAudio) {
            try {
              listenSummary = await measureListenPerformance({
                providerKey: `${selection.kind}:${selection.id}`,
                transcriber,
                audio: probeAudio,
                audioSeconds: wavSeconds(probeAudio),
                // 只有内置档有「载入模型」这回事；在线档每次都是同一条 fetch
                coldCapable: selection.kind === "builtin",
                ...(signal ? { signal } : {}),
              });
            } catch (error) {
              listenProbeError = `「听」段实测失败：${
                error instanceof Error ? error.message : String(error)
              }`;
            }
          }
        }
      }

      // 想：主动探一次首 token 延迟（在线链路真正在意的读数）
      let thinkMeasurement:
        | { ttftSeconds: number; tokensPerSecond?: number }
        | undefined;
      let thinkReason: string | undefined;
      if (!settings.think) {
        thinkReason = "未选择「想」模型：完整回路需要一个对话模型。";
      } else {
        try {
          thinkMeasurement = await (deps.probeThink ?? probeThinkTtft(deps))(
            user,
            settings.think,
            signal,
          );
        } catch (error) {
          thinkReason = `「想」段探测失败：${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      const report = buildReport({
        hardware,
        // 探针失败但历史使用里有读数时，历史读数仍是事实；两者都没有才把失败原因摆出来
        listen: listenSegment(
          listenSummary,
          listenReason ??
            (listenSummary.samples === 0 ? listenProbeError : undefined),
        ),
        think: thinkSegment(thinkMeasurement, thinkReason),
        speak: speakSegment(speakMeasurement, speakReason),
      });
      lastDiagnose = report;
      if (deps.diagnoseStore) {
        // 先写库再改内存（写失败不该让内存里出现一个只存在于本次进程的报告）
        await deps.diagnoseStore
          .save(report)
          .catch((error: unknown) =>
            console.warn(
              "[voice] 检测报告写入失败（结果仍可本次查看）：",
              error instanceof Error ? error.message : String(error),
            ),
          );
      }
      return report;
    },
  };

  /**
   * 「听」段的主动实测（点「重新检测」时真跑一次转写）。
   *
   * 为什么不是历史统计：耗时日志是**进程内存**里的，重启即空；只看它会让「重新检测」
   * 在没说过话（或刚重启）时永远回「未实测」。探针音频来自本机/在线 TTS 模型现场
   * 合成的一句真实语音——不是静音或类语音带（那两种与真语音的 RTF 差 1.3~4.8 倍，
   * 见 diagnose.ts 文件头）。
   *
   * 冷启动那一次单独记成 `modelLoadMs`（与真实使用埋点同口径），稳态那一次算 RTF；
   * 只有内置档有「载入模型」这回事，在线档只跑一次。
   */
  async function measureListenPerformance(input: {
    providerKey: string;
    transcriber: VoiceTranscriber;
    audio: Uint8Array;
    audioSeconds: number;
    coldCapable: boolean;
    signal?: AbortSignal;
  }): Promise<VoiceListenSummary> {
    const { providerKey, transcriber, audio, audioSeconds } = input;
    if (!(audioSeconds > 0)) {
      throw new Error("探针音频时长读不出来。");
    }
    const run = async () => {
      const started = Date.now();
      await transcriber.transcribe(
        audio,
        input.signal ? { signal: input.signal } : {},
      );
      return Date.now() - started;
    };
    let modelLoadMs = input.coldCapable
      ? modelLoadMsByProvider.get(providerKey)
      : undefined;
    if (input.coldCapable && !warmedProviders.has(providerKey)) {
      modelLoadMs = await run();
      modelLoadMsByProvider.set(providerKey, modelLoadMs);
      warmedProviders.add(providerKey);
    }
    const elapsedMs = await run();
    return {
      rtfMedian: elapsedMs / 1000 / audioSeconds,
      // 一次探针就是一个稳态样本；中位数的语义由 listenSegment 原样消费
      samples: 1,
      ...(modelLoadMs === undefined ? {} : { modelLoadMs }),
      lastClipSeconds: audioSeconds,
    };
  }

  /**
   * 静音检测是**内部优化**（不是用户可选项）：内置 VAD 模型在本地就直接用。
   * 它不参与「能力是否可用」的判定——VAD 缺席时照常转写，只是少了掐头去尾。
   */
  async function resolveVad(): Promise<VoiceActivityDetector | undefined> {
    const provider = builtinProvider({
      kind: "builtin",
      id: SILERO_VAD_MODEL.id,
    });
    const vad = provider.vad;
    if (!vad) {
      return undefined;
    }
    const verdict = await vad.ready();
    if (!verdict.ok) {
      console.warn(
        `[voice] 静音检测不可用，转写不做掐头去尾：${verdict.reason ?? "未知原因"}`,
      );
      return undefined;
    }
    return vad;
  }
}

/**
 * 掐掉首尾静音再转写。理由不是省时间：ASR 对**长段静音**常产出幻听文本
 * （「谢谢观看」一类），按住说话录进的前后静音正是这种噪声的常见来源。
 * 全段都判为静音时直接回空文本，不白跑一次识别。
 */
/** 从 WAV 头读音频时长（检测里算实时率用；读不出就当 0，不猜）。 */
function wavSeconds(wav: Uint8Array): number {
  try {
    return probeWav(wav).durationSeconds;
  } catch {
    return 0;
  }
}

/**
 * 探针音频统一成 16k 单声道 WAV：TTS 模型（如 Kokoro）产出 24k，而真实使用路径是
 * 客户端先转成 16k 再上传。不统一的话，内置 ASR 会多做一次线性重采样，把那段开销
 * 算进「听」的实时率里（系统性偏慢）。解不开的音频原样返回，让转写侧如实失败。
 */
function normalizeProbeAudio(wav: Uint8Array): Uint8Array {
  try {
    const decoded = decodeWav(wav);
    if (decoded.sampleRate === VOICE_SAMPLE_RATE) {
      return wav;
    }
    return encodeWav(
      resampleLinear(decoded.samples, decoded.sampleRate, VOICE_SAMPLE_RATE),
      VOICE_SAMPLE_RATE,
    );
  } catch {
    return wav;
  }
}

function withSilenceTrim(
  transcriber: VoiceTranscriber,
  vad: VoiceActivityDetector,
): VoiceTranscriber {
  return {
    ready: () => transcriber.ready(),
    async transcribe(wav, opts) {
      const decoded = decodeWav(wav);
      const { segments } = vad.segment(floatToPcm16Array(decoded.samples));
      if (segments.length === 0) {
        return { text: "" };
      }
      const first = segments[0];
      const last = segments[segments.length - 1];
      if (!first || !last) {
        return { text: "" };
      }
      const speech = decoded.samples.subarray(first[0], last[1]);
      if (speech.length === 0) {
        return { text: "" };
      }
      return transcriber.transcribe(
        encodeWav(speech, decoded.sampleRate),
        opts,
      );
    },
  };
}

/**
 * 内置 Provider 组装：从目录表取该模型的文件布局，把相对路径拼到模型目录上。
 * 听与 VAD 装在**同一个** provider 里（同一次 dlopen、同一份模块结论），
 * 这也是 VAD 能作为「内部优化」静默参与的原因。
 */
function createBuiltinProviderFromModelsRoot(
  modelsRoot: string,
  selection: VoiceSelection,
): VoiceProvider {
  const models: SherpaModels = {};
  const spec = findBuiltinModel(selection.id);
  if (spec?.segment === "listen") {
    const dir = resolveBuiltinModelDir(modelsRoot, spec.id);
    models.asr = {
      model: join(dir, spec.layout.model),
      // 目录表里 ASR 必有词表（catalog 测试锁死），这里缺了就是表写坏了
      tokens: join(dir, spec.layout.tokens ?? ""),
    };
  }
  if (spec?.segment === "speak") {
    const dir = resolveBuiltinModelDir(modelsRoot, spec.id);
    models.tts = {
      // 目录表的 layout 是模型自身知识，按 id 映射到 sherpa 的档位
      kind: spec.id.startsWith("kokoro") ? "kokoro" : "vits",
      model: join(dir, spec.layout.model),
      tokens: join(dir, spec.layout.tokens ?? "tokens.txt"),
      ...(spec.layout.lexicon
        ? { lexicon: join(dir, spec.layout.lexicon) }
        : {}),
      ...(spec.layout.dataDir
        ? { dataDir: join(dir, spec.layout.dataDir) }
        : {}),
      ...(spec.layout.voices ? { voices: join(dir, spec.layout.voices) } : {}),
    };
  }
  const vadSpec = SILERO_VAD_MODEL;
  const vadDir = resolveBuiltinModelDir(modelsRoot, vadSpec.id);
  models.vad = { model: join(vadDir, vadSpec.layout.model) };
  return createSherpaProvider({ models });
}

/**
 * 转写耗时埋点（规划 §6 的「运行期实测」）：包在 provider 外面，调用方（路由）
 * 无法忘记记录。音频时长从 WAV 头读（不解码 8MB 样本），**只记时长与耗时**。
 *
 * 只记**成功**的转写：失败耗时不是吞吐读数（一个立刻失败的坏音频会把中位数拉成
 * 「这台机器飞快」），而失败本身已经由错误信息交代了。
 */
function withTranscriptionTiming(
  transcriber: VoiceTranscriber,
  isCold: () => boolean,
  log: VoiceTimingLog,
): VoiceTranscriber {
  return {
    ready: () => transcriber.ready(),
    async transcribe(wav, opts) {
      const cold = isCold();
      const started = Date.now();
      const result = await transcriber.transcribe(wav, opts);
      let clipSeconds: number | undefined;
      try {
        clipSeconds = probeWav(wav).durationSeconds;
      } catch {
        // 时长读不出来就不记（宁缺勿假：编一个实时率比没有读数更坏）
      }
      if (clipSeconds !== undefined) {
        log.record({ clipSeconds, elapsedMs: Date.now() - started, cold });
      }
      return result;
    },
  };
}

/**
 * 「想」段的首 token 延迟探针（规划 §6：语音闭环真正在意的是它）。
 *
 * 打的是用户自己的 BYOK 对话模型：一条极短提示 + 只读第一个 chunk 就掐断，
 * 尽量少花 token。**只报能证的数**——生成速度只在流末给出 usage 时才报，
 * 拿 chunk 数冒充 token 数会给出一个看着精确、实则错的读数。
 */
function probeThinkTtft(deps: VoiceServiceDeps) {
  return async (
    user: LocalActor,
    selection: VoiceSelection,
    signal?: AbortSignal,
  ): Promise<{ ttftSeconds: number; tokensPerSecond?: number }> => {
    if (selection.kind === "builtin") {
      // 离线档：llamafile 流式打一条固定短提示（真首 token 延迟 + 有 usage 才报 tok/s）
      const provider = (deps.createThinkProvider ?? defaultThinkProvider(deps))(
        selection,
      );
      const ready = await provider.ready();
      if (!ready.ok) {
        throw new Error(ready.reason ?? "离线「想」模型未就绪。");
      }
      return provider.probe(signal);
    }
    if (!selection.model) {
      throw new Error("「想」段的供应商实例未指定模型。");
    }
    const credentials = await deps.modelProviders.resolveCredentials(
      user,
      selection.id,
    );
    const model = resolveInstanceChatModel(
      credentials.protocol,
      selection.model,
      {
        apiKey: credentials.apiKey,
        ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
        ...(credentials.headers ? { headers: credentials.headers } : {}),
      },
    );
    const started = Date.now();
    const stream = await model.stream(
      [
        new SystemMessage("你在测链路速度，直接回答即可。"),
        new HumanMessage("说「好」。"),
      ],
      signal ? { signal } : {},
    );
    let firstChunkAt: number | undefined;
    let outputTokens: number | undefined;
    for await (const chunk of stream) {
      if (firstChunkAt === undefined) {
        firstChunkAt = Date.now();
      }
      const usage = (chunk as { usage_metadata?: { output_tokens?: number } })
        .usage_metadata;
      if (usage?.output_tokens) {
        outputTokens = usage.output_tokens;
      }
    }
    if (firstChunkAt === undefined) {
      throw new Error("端点没有返回任何内容。");
    }
    const ttftSeconds = (firstChunkAt - started) / 1000;
    const elapsed = (Date.now() - started) / 1000;
    return {
      ttftSeconds,
      ...(outputTokens === undefined || elapsed <= 0
        ? {}
        : { tokensPerSecond: outputTokens / elapsed }),
    };
  };
}

/**
 * 「想」段的离线档默认实现：llamafile（模型 + 运行时同一文件，见 providers/llamafile.ts）。
 * 每次调用新建（与实例档同口径：内部进程单例按需惰性起，构造本身零成本）。
 */
function defaultThinkProvider(
  deps: VoiceServiceDeps,
): (selection: VoiceSelection) => LlamafileThinkProvider {
  return (selection) =>
    createLlamafileThinkProvider({
      modelsRoot: deps.modelsRoot,
      modelId: selection.id,
    });
}

/**
 * 「想」段的默认实现：用用户自己的 BYOK 对话模型把口述补成完整需求。
 *
 * 提示词只做「补全与澄清」，**不替用户加需求**（三个不许：不许加约束、不许换技术栈、
 * 不许改意图）——方案 B 会自动执行改写结果，模型越权加需求就是替用户做决定。
 */
function refineWithInstanceChat(deps: VoiceServiceDeps) {
  return async (
    user: LocalActor,
    selection: VoiceSelection,
    input: { text: string; recentMessages?: VoiceRefineContextMessage[] },
    signal?: AbortSignal,
  ): Promise<string> => {
    if (!selection.model) {
      throw new Error("「想」段的供应商实例未指定模型。");
    }
    const credentials = await deps.modelProviders.resolveCredentials(
      user,
      selection.id,
    );
    const model = resolveInstanceChatModel(
      credentials.protocol,
      selection.model,
      {
        apiKey: credentials.apiKey,
        ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
        ...(credentials.headers ? { headers: credentials.headers } : {}),
      },
    );
    const context = (input.recentMessages ?? []).map((message) =>
      message.role === "user"
        ? new HumanMessage(message.content)
        : new AIMessage(message.content),
    );
    const response = await model.invoke(
      [
        // 与离线档（llamafile）共用同一份系统提示词：两条路只差承载，口径必须一致
        new SystemMessage(REFINE_SYSTEM_PROMPT),
        ...context,
        new HumanMessage(input.text),
      ],
      signal ? { signal } : {},
    );
    const text =
      typeof response.content === "string"
        ? response.content
        : response.content
            .map((part: unknown) =>
              typeof part === "object" && part !== null && "text" in part
                ? String((part as { text: unknown }).text ?? "")
                : "",
            )
            .join("");
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("「想」段没有返回内容。");
    }
    return trimmed;
  };
}
