/**
 * 语音能力缝的定义（《语音助手插件规划》§2.1）。
 *
 * 三条能力：听（转写）/ 说（合成）/ VAD（离线切句）。它们都**不是模型可调用工具**
 * （模型看不到），故不向 `ctx.tools` 贡献——Provider 由 `voice` 服务按设置解析，
 * Consumer 是 `http/voice.ts` 的路由（规划 §2.3）。
 *
 * 三段可混搭（规划 §3.4）：同一个 Provider 按段可选地承载能力，而不是三选一。
 */

/**
 * 可用性判定：不可用时**必须**给出可读原因。
 * 规划 §6 的硬规则——性能不足给警告，只有硬缺失（模型未下载、端点不可达）才置灰，
 * 而置灰要写明为什么，这正是 `reason` 的用途。
 */
export interface VoiceAvailability {
  ok: boolean;
  reason?: string;
}

/** 三段共同的就绪判定（性能检测与 fail loud 共用）。 */
export interface VoiceReady {
  ready(): Promise<VoiceAvailability>;
}

export interface TranscribeOptions {
  /** 语言提示（如 `zh`）；缺省由模型自行判定。 */
  language?: string;
  signal?: AbortSignal;
}

/** 听：16kHz 单声道 WAV 字节 → 文本。 */
export interface VoiceTranscriber extends VoiceReady {
  transcribe(
    wav: Uint8Array,
    opts?: TranscribeOptions,
  ): Promise<{ text: string }>;
}

export interface SynthesizeOptions {
  /** 音色标识：内置路径是 speaker id，远端是 voice 名。 */
  voice?: string;
  signal?: AbortSignal;
}

/** 说：文本 → 音频字节（mimeType 由实现给出，内置路径是 audio/wav）。 */
export interface VoiceSynthesizer extends VoiceReady {
  synthesize(
    text: string,
    opts?: SynthesizeOptions,
  ): Promise<{ audio: Uint8Array; mimeType: string }>;
}

/**
 * VAD：把一段 PCM 切成语音段（`[起始采样点, 结束采样点)`）。
 * 只服务离线切句，不做常驻监听（规划 §8）。
 */
export interface VoiceActivityDetector extends VoiceReady {
  segment(pcm: Int16Array): { segments: Array<[number, number]> };
}

/** 运行位置标注（规划 §3.4）：内置路径走 CPU，GPU 与远端都是外部端点。 */
export type VoiceRunLocation = "cpu" | "gpu" | "remote";

/**
 * 一个 Provider 能承载的能力子集：内置 sherpa 三件全有，OpenAI 兼容端点只有听说。
 * `id` 是设置里记录的值，稳定不变。
 */
export interface VoiceProvider {
  id: string;
  label: string;
  location: VoiceRunLocation;
  transcriber?: VoiceTranscriber;
  synthesizer?: VoiceSynthesizer;
  vad?: VoiceActivityDetector;
}
