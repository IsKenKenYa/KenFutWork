import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  voiceDiagnoseResponseSchema,
  voiceModelListResponseSchema,
  voiceModelResponseSchema,
  voiceRefineRequestSchema,
  voiceRefineResponseSchema,
  voiceSettingsResponseSchema,
  voiceSettingsUpdateRequestSchema,
  voiceTranscribeResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import { VoiceAudioError } from "../features/voice/audio.js";
import {
  VoiceModelError,
  type VoiceModelStore,
} from "../features/voice/model-store.js";
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
    /**
     * 内置模型的下载 / 删除（规划 §5）。缺席时只提供目录与设置读写
     * ——"未装"要表现在路由不存在（404）而不是给个会炸的假接口。
     */
    modelStore?: VoiceModelStore;
  },
) {
  const { modelStore } = options;

  /** 单条候选（下载 / 取消 / 删除后回的那条）。 */
  async function findCandidate(
    user: Awaited<ReturnType<RequestAuthenticator["authenticate"]>>,
    modelId: string,
  ) {
    if (!user) throw new VoiceUnavailableError("未认证。");
    const models = await options.voiceService.listCandidates(user);
    const candidate = models.find(
      (item) => item.kind === "builtin" && item.id === modelId,
    );
    if (!candidate) {
      throw new VoiceModelError(`未知的内置模型：${modelId}`);
    }
    return candidate;
  }

  if (modelStore) {
    const store = modelStore;

    app.get("/api/voice/models", async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const models = await options.voiceService.listCandidates(user);
        return reply
          .code(200)
          .send(voiceModelListResponseSchema.parse({ models }));
      } catch (error) {
        return sendVoiceError(error, reply);
      }
    });

    // 下载是文件系统副作用但可重放（校验和不匹配即失败且不留半截文件），
    // 故允许重试；接口立刻回 202，进度由前端轮询 GET /api/voice/models。
    app.post<{ Params: { modelId: string } }>(
      "/api/voice/models/:modelId/download",
      async (request, reply) => {
        try {
          const user = await options.auth.authenticate(request);
          if (!user) return sendUnauthorized(reply);
          // **先校验再动手**：路由自己挡住未知/非内置 id，不把「能不能下」这件事
          // 交给 store 的副作用路径去发现（那里的失败发生在已经开下载之后）
          const candidate = await findCandidate(user, request.params.modelId);
          await store.start(request.params.modelId);
          const download = await store.getState(request.params.modelId);
          return reply.code(202).send(
            voiceModelResponseSchema.parse({
              model: { ...candidate, download },
            }),
          );
        } catch (error) {
          return sendVoiceError(error, reply);
        }
      },
    );

    app.delete<{ Params: { modelId: string } }>(
      "/api/voice/models/:modelId/download",
      async (request, reply) => {
        try {
          const user = await options.auth.authenticate(request);
          if (!user) return sendUnauthorized(reply);
          store.cancel(request.params.modelId);
          const model = await findCandidate(user, request.params.modelId);
          return reply
            .code(200)
            .send(voiceModelResponseSchema.parse({ model }));
        } catch (error) {
          return sendVoiceError(error, reply);
        }
      },
    );

    app.delete<{ Params: { modelId: string } }>(
      "/api/voice/models/:modelId",
      async (request, reply) => {
        try {
          const user = await options.auth.authenticate(request);
          if (!user) return sendUnauthorized(reply);
          await store.remove(request.params.modelId);
          const model = await findCandidate(user, request.params.modelId);
          return reply
            .code(200)
            .send(voiceModelResponseSchema.parse({ model }));
        } catch (error) {
          return sendVoiceError(error, reply);
        }
      },
    );
  }
  /**
   * 检测报告：GET 读回上次结果（启动期读回的那份），POST 跑一次新的。
   * 规划 §6 要求「可取消、不阻塞界面」：检测是一次普通请求，前端用 AbortController
   * 取消即可——服务端把请求的中止信号透进探针，取消即停。
   */
  app.get("/api/voice/diagnose", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      return reply.code(200).send(
        voiceDiagnoseResponseSchema.parse({
          report: options.voiceService.getLastDiagnose(),
        }),
      );
    } catch (error) {
      return sendVoiceError(error, reply);
    }
  });

  app.post("/api/voice/diagnose", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const viewer = await options.viewerService.ensureViewer(user);
      const controller = new AbortController();
      // 客户端断开即中止（含「取消检测」）：别让探针在没人等的时候继续跑
      request.raw.once("close", () => controller.abort());
      const report = await options.voiceService.diagnose(
        user,
        viewer.workspace.id,
        controller.signal,
      );
      return reply
        .code(200)
        .send(voiceDiagnoseResponseSchema.parse({ report }));
    } catch (error) {
      return sendVoiceError(error, reply);
    }
  });

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

  /**
   * 「想」段（规划 §4.2）：口述 → 完整需求。
   *
   * 与转写一样**不落库、不写用量**（unsafe：HTTP 层不自动重试）；
   * 未选/不可用即 503 + 可读原因——静默回原文本等于骗用户「已经帮你理顺了」。
   */
  app.post("/api/voice/refine", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const payload = voiceRefineRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);
      const controller = new AbortController();
      // 客户端断开即中止（用户在撤销窗口里取消时不必再等模型）
      request.raw.once("close", () => controller.abort());
      const prompt = await options.voiceService.refine(
        user,
        viewer.workspace.id,
        {
          text: payload.text,
          ...(payload.recentMessages
            ? { recentMessages: payload.recentMessages }
            : {}),
        },
        controller.signal,
      );
      return reply.code(200).send(voiceRefineResponseSchema.parse({ prompt }));
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
  if (error instanceof VoiceModelError) {
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
