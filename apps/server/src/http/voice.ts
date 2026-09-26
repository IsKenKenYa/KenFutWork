import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  voiceSettingsResponseSchema,
  voiceSettingsUpdateRequestSchema,
  voiceTranscribeResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import { VoiceAudioError } from "../features/voice/audio.js";
import {
  type VoiceService,
  VoiceUnavailableError,
} from "../features/voice/voice-service.js";
import { describeZodIssues, isZodError } from "./zod-error.js";

/**
 * 语音路由（规划 §2.3）。
 *
 * 音频走**独立的路由与独立白名单**，不复用图片上传通道（那边只收图片 MIME，
 * 且语义是「存成素材」；语音是「即用即弃」，不入库）。
 *
 * 白名单只收 WAV：客户端自己把录音重采样成 16k 单声道 WAV（规划 §7），
 * 于是两条 provider 路径（内置解码 / 远端转发）都吃得下。收下 webm 再在
 * provider 层报「解不了」是把错误推给用户，不如在边界上说清。
 */
const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/vnd.wave",
]);

/** 单次录音上限：远小于全局 10MB（16k 单声道 WAV 一分钟约 1.9MB）。 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export async function registerVoiceRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    voiceService: VoiceService;
    viewerService: ViewerService;
  },
) {
  app.get("/api/voice/settings", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const viewer = await options.viewerService.ensureViewer(user);
      const settings = await options.voiceService.getSettings(
        user,
        viewer.workspace.id,
      );
      return reply
        .code(200)
        .send(voiceSettingsResponseSchema.parse({ settings }));
    } catch (error) {
      return sendVoiceError(error, reply);
    }
  });

  app.put("/api/voice/settings", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const payload = voiceSettingsUpdateRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);
      const settings = await options.voiceService.updateSettings(
        user,
        viewer.workspace.id,
        payload,
      );
      return reply
        .code(200)
        .send(voiceSettingsResponseSchema.parse({ settings }));
    } catch (error) {
      return sendVoiceError(error, reply);
    }
  });

  app.post("/api/voice/transcribe", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const file = await request.file();
      if (!file) {
        return sendInvalidInput(
          reply,
          "缺少音频数据（期望 multipart 的 file 字段）。",
        );
      }
      if (!ALLOWED_AUDIO_MIME_TYPES.has(file.mimetype)) {
        return sendInvalidInput(
          reply,
          `不支持的音频类型：${file.mimetype}（只收 WAV：客户端会把录音重采样成 16k 单声道 WAV）。`,
        );
      }
      let audio: Buffer;
      try {
        audio = await file.toBuffer();
      } catch (error) {
        return sendInvalidInput(
          reply,
          `音频读取失败（可能超过 ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)}MB 上限）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (audio.byteLength === 0) {
        return sendInvalidInput(reply, "音频为空。");
      }
      if (audio.byteLength > MAX_AUDIO_BYTES) {
        return sendInvalidInput(
          reply,
          `音频过大（${audio.byteLength} 字节，上限 ${MAX_AUDIO_BYTES}）。`,
        );
      }

      const viewer = await options.viewerService.ensureViewer(user);
      const { impl: transcriber, label } =
        await options.voiceService.resolveTranscriber(
          user,
          viewer.workspace.id,
        );
      const { text } = await transcriber.transcribe(audio);
      request.log.info(
        { bytes: audio.byteLength, provider: label },
        "[voice] 转写完成",
      );
      // 空文本是正常结果（用户没说），不是错误——前端据此提示「没听到语音」
      return reply
        .code(200)
        .send(voiceTranscribeResponseSchema.parse({ text }));
    } catch (error) {
      return sendVoiceError(error, reply);
    }
  });
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendInvalidInput(reply: FastifyReply, message: string) {
  return reply.code(400).send(
    applicationErrorResponseSchema.parse({
      error: { code: "invalid_input", message },
    }),
  );
}

function sendVoiceError(error: unknown, reply: FastifyReply) {
  // 包体不符合契约 → 400（判错的代价是「把客户端错误报成 500」，见 zod-error 的注释）
  if (isZodError(error)) {
    return sendInvalidInput(reply, describeZodIssues(error.issues));
  }
  // 未装/不可用 → 503（规划 §2.4 的口径，不新增错误码）
  if (error instanceof VoiceUnavailableError) {
    return reply.code(503).send(
      applicationErrorResponseSchema.parse({
        error: { code: "service_unavailable", message: error.message },
      }),
    );
  }
  if (error instanceof VoiceAudioError) {
    return sendInvalidInput(reply, error.message);
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "application_error",
        message: `语音处理失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    }),
  );
}
