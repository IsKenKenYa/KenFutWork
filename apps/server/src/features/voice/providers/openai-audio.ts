/**
 * OpenAI 兼容端点 Provider（规划 §2.2）：听 / 说两段走**既有 BYOK 供应商实例**的
 * `baseUrl` / 凭证 / 自定义头——在线档因此不需要新协议，也不需要新配置通道。
 *
 * 走的就是既有「本地端点」路子：`baseUrl` 填 `http://127.0.0.1:PORT/v1` 即本地
 * Speaches / faster-whisper server / whisper.cpp 的 OAI-like API；填云端地址即云端。
 * 「本机 GPU」与「远端」在这条路径上**是同一条代码**，差别只在 baseUrl 指向谁
 * （规划 §3.4：运行位置是标注，不是另一套配置通道）。
 *
 * 听与说是**两个模型**（如 whisper-1 / tts-1），不能靠 `capability === "audio"` 猜，
 * 故由设置显式给出 `transcribeModel` / `speechModel`，猜不出来就不给这段能力。
 */

import type { InstanceCredentials } from "../../../providers/types.js";
import type {
  VoiceProvider,
  VoiceSynthesizer,
  VoiceTranscriber,
} from "../types.js";

/** 缺省端点：不填 baseUrl 时按 OpenAI 官方地址（与聊天适配器同口径）。 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** 转写/合成请求超时（毫秒）。语音交互不该无限等，卡住要能失败。 */
const REQUEST_TIMEOUT_MS = 120_000;

export interface InstanceAudioAdapterOptions {
  credentials: InstanceCredentials;
  /** 听段模型 id（如 `whisper-1`）；缺省 = 该实例不提供转写。 */
  transcribeModel?: string;
  /** 说段模型 id（如 `tts-1`）；缺省 = 该实例不提供合成。 */
  speechModel?: string;
  /** 说段音色（如 `alloy`）；缺省交给端点默认。 */
  voice?: string;
  /** 测试注入。 */
  fetchFn?: typeof fetch;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** 凭证 → 请求头（自定义头在前，凭证头在后，凭证不可被顶掉，与 §4.8 保留头口径一致）。 */
function authHeaders(credentials: InstanceCredentials): Record<string, string> {
  return {
    ...credentials.headers,
    authorization: `Bearer ${credentials.apiKey}`,
  };
}

async function readErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim().slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * 建 OpenAI 兼容音频 Provider。
 * 端点不可达/鉴权失败都在**调用时** fail loud（可读中文原因），`ready()` 只判配置齐全
 * ——不在这里发探测请求：`ready()` 会被设置页频繁调用，不该产生网络副作用。
 */
export function createInstanceAudioProvider(
  options: InstanceAudioAdapterOptions,
): VoiceProvider {
  const baseUrl = trimSlash(options.credentials.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch = options.fetchFn ?? fetch;
  const headers = authHeaders(options.credentials);
  const { transcribeModel, speechModel } = options;

  const transcriber: VoiceTranscriber = {
    async ready() {
      if (!options.credentials.apiKey) {
        return { ok: false, reason: "供应商实例缺少凭证。" };
      }
      if (!transcribeModel) {
        return { ok: false, reason: "该实例未指定转写模型（听）。" };
      }
      return { ok: true };
    },
    async transcribe(wav, opts) {
      if (!transcribeModel) {
        throw new Error("该实例未指定转写模型（听）。");
      }
      const form = new FormData();
      form.append("model", transcribeModel);
      form.append(
        "file",
        new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
        "audio.wav",
      );
      if (opts?.language) {
        form.append("language", opts.language);
      }
      const response = await doFetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers,
        body: form,
        signal: opts?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `转写请求失败（HTTP ${response.status}）：${await readErrorText(response)}`,
        );
      }
      const payload = (await response.json()) as { text?: unknown };
      if (typeof payload.text !== "string") {
        throw new Error("转写端点未返回 text 字段。");
      }
      return { text: payload.text.trim() };
    },
  };

  const synthesizer: VoiceSynthesizer = {
    async ready() {
      if (!options.credentials.apiKey) {
        return { ok: false, reason: "供应商实例缺少凭证。" };
      }
      if (!speechModel) {
        return { ok: false, reason: "该实例未指定语音模型（说）。" };
      }
      return { ok: true };
    },
    async synthesize(text, opts) {
      if (!speechModel) {
        throw new Error("该实例未指定语音模型（说）。");
      }
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("待合成的文本为空（fail loud）。");
      }
      const voice = opts?.voice ?? options.voice;
      const response = await doFetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: speechModel,
          input: trimmed,
          response_format: "wav",
          ...(voice ? { voice } : {}),
        }),
        signal: opts?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `语音合成失败（HTTP ${response.status}）：${await readErrorText(response)}`,
        );
      }
      return {
        audio: new Uint8Array(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") ?? "audio/wav",
      };
    },
  };

  return {
    id: `instance:${options.credentials.baseUrl ?? "openai"}`,
    label: options.credentials.baseUrl ? "外部端点" : "OpenAI 官方",
    location: "remote",
    ...(transcribeModel ? { transcriber } : {}),
    ...(speechModel ? { synthesizer } : {}),
  };
}
