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
  VoiceModelCandidate,
  VoiceSelection,
  VoiceSettings,
  VoiceSettingsUpdateRequest,
} from "@kenfutwork/shared";
import { resolveInstanceAudioProvider } from "../../providers/resolve.js";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import { decodeWav, encodeWav, floatToPcm16Array } from "./audio.js";
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
import type { VoiceModelStore } from "./model-store.js";
import { createSherpaProvider, type SherpaModels } from "./providers/sherpa.js";
import type { VoiceRepository } from "./repository.js";
import type {
  VoiceActivityDetector,
  VoiceProvider,
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
  /** 测试注入：内置 Provider 工厂（默认走 sherpa）。 */
  createBuiltinProvider?: (selection: VoiceSelection) => VoiceProvider;
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
}

export function createVoiceService(deps: VoiceServiceDeps): VoiceService {
  /** 内置 Provider 缓存（键 = 选择的三段文件集合；见文件头的缓存口径）。 */
  const builtinCache = new Map<string, VoiceProvider>();

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
      return {
        impl: vad ? withSilenceTrim(transcriber, vad) : transcriber,
        label: provider.label,
      };
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
