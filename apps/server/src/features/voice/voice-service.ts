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

import type { AuthenticatedUser } from "../auth/types.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import { decodeWav, encodeWav, floatToPcm16Array, probeWav } from "./audio.js";
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
  speakSegment,
  thinkSegment,
} from "./diagnose.js";
import type { VoiceModelStore } from "./model-store.js";
import { createSherpaProvider, type SherpaModels } from "./providers/sherpa.js";
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
    user: AuthenticatedUser,
    selection: VoiceSelection,
    input: { text: string; recentMessages?: VoiceRefineContextMessage[] },
    signal?: AbortSignal,
  ) => Promise<string>;
  /** 测试注入：想段 TTFT 探针（默认打用户的 BYOK 对话模型）。 */
  probeThink?: (
    user: AuthenticatedUser,
    selection: VoiceSelection,
    signal?: AbortSignal,
  ) => Promise<{ ttftSeconds: number; tokensPerSecond?: number }>;
}

export interface VoiceService {
  getSettings(
    user: AuthenticatedUser,
    workspaceId: string,
  ): Promise<VoiceSettings>;
  updateSettings(
    user: AuthenticatedUser,
    workspaceId: string,
    patch: VoiceSettingsUpdateRequest,
  ): Promise<VoiceSettings>;
  /** 解析「听」段；未就绪即抛 `VoiceUnavailableError`（可读原因）。 */
  resolveTranscriber(
    user: AuthenticatedUser,
    workspaceId: string,
  ): Promise<ResolvedSegment<VoiceTranscriber>>;
  /**
   * 三段的候选卡片（规划 §5）：内置离线模型（含下载状态）+ 该用户自己的音频/对话
   * 模型实例。**只列真能用的**：不可用的带 `unavailableReason` 置灰并写明原因。
   */
  listCandidates(
    user: AuthenticatedUser,
    segment?: "listen" | "think" | "speak",
  ): Promise<VoiceModelCandidate[]>;
  /**
   * 「想」段：把口述补成完整需求（规划 §4.2）。
   * 未选/不可用即抛 `VoiceUnavailableError`（可读原因），**不静默回原文本**——
   * 静默回落会让用户以为模型改写过，实际什么都没发生。
   */
  refine(
    user: AuthenticatedUser,
    workspaceId: string,
    input: { text: string; recentMessages?: VoiceRefineContextMessage[] },
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * 解析「说」段；未就绪即抛 `VoiceUnavailableError`（可读原因）。
   * 当前只有 BYOK 端点档（内置档待定，见 catalog 注释）。
   */
  resolveSynthesizer(
    user: AuthenticatedUser,
    workspaceId: string,
  ): Promise<ResolvedSegment<VoiceSynthesizer>>;
  /** 真实使用的「听」实测汇总（检测页与检测报告共用）。 */
  getListenTimings(): VoiceListenSummary;
  /** 上次检测报告（启动期读回的那份；没测过回 null）。 */
  getLastDiagnose(): VoiceDiagnoseReport | null;
  /** 跑一次检测并持久化（规划 §6）。 */
  diagnose(
    user: AuthenticatedUser,
    workspaceId: string,
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

  async function readSettings(workspaceId: string): Promise<VoiceSettings> {
    const raw = await deps.repository.findVoice(workspaceId);
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

  /** 实例段：按**用户作用域**解析凭证（不是 worker 的 resolveCredentialsById）。 */
  async function instanceProvider(
    user: AuthenticatedUser,
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
    user: AuthenticatedUser,
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
    getSettings(user, workspaceId) {
      void user;
      return readSettings(workspaceId);
    },

    async updateSettings(user, workspaceId, patch) {
      void user;
      const current = await readSettings(workspaceId);
      const next = mergeVoiceSettings(current, patch);
      // 先写库再返回：读回的是库里的事实，不是「我以为写成了什么」
      await deps.repository.upsertVoice(workspaceId, next);
      return parseVoiceSettings(await deps.repository.findVoice(workspaceId));
    },

    async resolveTranscriber(user, workspaceId) {
      const settings = await readSettings(workspaceId);
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
      for (const model of BUILTIN_VOICE_MODELS) {
        if (model.segment === "vad" || !targets.includes(model.segment)) {
          continue;
        }
        const sizeBytes = builtinModelSizeBytes(model);
        const state = await deps.modelStore?.getState(model.id);
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
          performanceNote:
            "预估：本机 CPU 转写实时率约 0.1–0.3（下载后由检测换成实测）",
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
              label: `${instance.name} · ${model.name}`,
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
              performanceNote: "延迟取决于端点（检测可实测）",
              ...(instance.enabled
                ? {}
                : { unavailableReason: "该供应商实例已停用" }),
            });
          }
        }
      }

      return [...builtin, ...instanceCandidates];
    },

    async refine(user, workspaceId, input, signal) {
      const settings = await readSettings(workspaceId);
      if (!settings.think) {
        throw new VoiceUnavailableError(
          "未选择「想」模型：完整回路需要一个对话模型（到「设置 → 语音」选一个）。",
        );
      }
      if (settings.think.kind !== "instance") {
        throw new VoiceUnavailableError(
          "「想」段目前只支持在线（BYOK 对话模型）——内置离线档需要额外的推理运行时。",
        );
      }
      const run = deps.refine ?? refineWithInstanceChat(deps);
      return run(user, settings.think, input, signal);
    },

    async resolveSynthesizer(user, workspaceId) {
      const settings = await readSettings(workspaceId);
      const selection = settings.speak;
      if (!selection) {
        throw new VoiceUnavailableError(
          "未选择「说」模型：到「设置 → 语音」选一个（当前只支持 BYOK 语音端点）。",
        );
      }
      if (selection.kind === "builtin") {
        throw new VoiceUnavailableError(
          "内置「说」档待定（许可与体积未拍板），「说」段目前只支持 BYOK 端点。",
        );
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

    async diagnose(user, workspaceId, signal) {
      const settings = await readSettings(workspaceId);
      const hardware = await (deps.collectHardware ?? collectHardware)();

      // 听：用真实使用的实测汇总（首次载入另计）；未选模型则明确置灰
      let listenReason: string | undefined;
      if (!settings.listen) {
        listenReason =
          "未选择「听」模型：到「设置 → 语音」选一个（内置模型需先下载）。";
      } else {
        const verdict = await resolveProvider(
          user,
          settings.listen,
          "listen",
          "听",
        )
          .then((provider) => provider.transcriber?.ready())
          .catch((error: unknown) => ({
            ok: false as const,
            reason: error instanceof Error ? error.message : String(error),
          }));
        if (verdict && !verdict.ok) {
          listenReason = verdict.reason ?? "「听」模型不可用。";
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
        listen: listenSegment(timingLog.summary(), listenReason),
        think: thinkSegment(thinkMeasurement, thinkReason),
        // 内置「说」档待定（许可与体积），BYOK 端点候选已在目录里但这条路还没接
        speak: speakSegment(),
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
    user: AuthenticatedUser,
    selection: VoiceSelection,
    signal?: AbortSignal,
  ): Promise<{ ttftSeconds: number; tokensPerSecond?: number }> => {
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
 * 「想」段的默认实现：用用户自己的 BYOK 对话模型把口述补成完整需求。
 *
 * 提示词只做「补全与澄清」，**不替用户加需求**（三个不许：不许加约束、不许换技术栈、
 * 不许改意图）——方案 B 会自动执行改写结果，模型越权加需求就是替用户做决定。
 */
function refineWithInstanceChat(deps: VoiceServiceDeps) {
  return async (
    user: AuthenticatedUser,
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
        new SystemMessage(
          [
            "你负责把用户的口述补成一条可直接执行的完整需求（中文，一段话）。",
            "只做三件事：补全被省略的主语/对象、把口语指代按上下文落实、点明可验收的结果。",
            "三个不许：不许添加用户没说的约束、不许更换用户指定的技术或方案、不许改变用户意图。",
            "信息不足时按上下文最合理的解释补全，不要反问。只输出补全后的需求，不要解释。",
          ].join(String.fromCharCode(10)),
        ),
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
