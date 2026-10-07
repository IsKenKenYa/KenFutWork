import {
  applicationErrorResponseSchema,
  generateImageRequestSchema,
  generateVideoRequestSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { JobService } from "../features/jobs/job-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { LocalInstanceMaintenanceError } from "../features/local-instance/service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../features/local-instance/types.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type { UsageService } from "../features/usage/usage-service.js";
import type { GeneratedImage } from "../generation/types.js";
import { instanceHeadersOption } from "../providers/instance-headers.js";
import { resolveInstanceImageProvider } from "../providers/resolve.js";

export async function registerGenerateRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    jobService?: JobService;
    /** BYOK 实例凭证解析（直连生成按实例实例化适配器）。 */
    modelProviders?: ModelProviderService;
    uploadService: UploadService;
    localInstance: LocalInstanceService;
    usage: UsageService;
  },
) {
  app.post("/api/agent/generate-image", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "本机接入凭据缺失或无效。",
          },
        }),
      );
    }

    let payload: z.infer<typeof generateImageRequestSchema>;
    try {
      payload = generateImageRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    // BYOK-only（2026-09-18 用户拍板删除内置目录/遗留 env 注册）：必须指定供应商实例。
    if (!payload.providerInstanceId || !options.modelProviders) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message:
              "缺少 providerInstanceId——请先在「设置 → 供应商」添加供应商实例后再发起生成。",
          },
        }),
      );
    }
    const model = payload.model;
    if (!model) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "缺少 model（从实例模型清单中选择）。",
          },
        }),
      );
    }

    let releaseAdmission: (() => void) | undefined;
    try {
      releaseAdmission = options.localInstance.beginAdmission();
      const { instanceId } = await options.localInstance.resolve(user);
      let result: GeneratedImage;
      {
        const credentials = await options.modelProviders.resolveCredentials(
          user,
          payload.providerInstanceId,
        );
        const provider = resolveInstanceImageProvider(credentials.protocol, {
          credentials: {
            apiKey: credentials.apiKey,
            ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
            // 自定义头（§4.8）占位符按请求携带的会话渲染；确无会话时由渲染层 fail loud
            // 给出可读原因，而不是发出字面量 `{{sessionId}}`。
            ...instanceHeadersOption(credentials.headers, {
              sessionId: payload.sessionId,
              threadId: payload.threadId,
            }),
          },
          models: credentials.models
            .filter(
              (m) => m.capability === "image" || m.capability === "image-edit",
            )
            .map((m) => ({ id: m.id, name: m.name })),
        });
        result = await provider.generate({
          prompt: payload.prompt,
          model,
          aspectRatio: payload.aspectRatio ?? "1:1",
          ...(payload.quality ? { quality: payload.quality } : {}),
          ...(payload.inputImages?.length
            ? { inputImages: payload.inputImages }
            : {}),
        });
      }

      await options.usage.record({
        instanceId,
        accessClientId: user.accessClientId,
        provider: "instance",
        providerInstanceId: payload.providerInstanceId,
        model,
        capability: "image",
      });

      // 下载供应商产物并经本机存储缝持久化。
      const { signedUrl, assetId } = await downloadAndUpload(
        result.url,
        result.mimeType,
        payload.prompt,
        user,
        options,
      );

      return reply.code(200).send({
        url: signedUrl,
        assetId,
        prompt: payload.prompt,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      if (error instanceof LocalInstanceMaintenanceError)
        return reply
          .code(503)
          .send({ error: { code: error.code, message: error.message } });
      const message =
        error instanceof Error ? error.message : "Image generation failed.";

      if (message.includes("No provider registered")) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "provider_not_configured",
              message: "Image generation is not available.",
            },
          }),
        );
      }

      return reply.code(502).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "generation_failed",
            message,
          },
        }),
      );
    } finally {
      releaseAdmission?.();
    }
  });

  // ── POST /api/agent/generate-video ──────────────────────────
  app.post("/api/agent/generate-video", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "本机接入凭据缺失或无效。",
          },
        }),
      );
    }

    let payload: z.infer<typeof generateVideoRequestSchema>;
    try {
      payload = generateVideoRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    if (!options.jobService) {
      return reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "service_unavailable",
            message:
              "Video generation is not available (job service not configured).",
          },
        }),
      );
    }

    // BYOK-only（2026-09-18 用户拍板）：必须指定供应商实例与模型。
    if (
      !payload.providerInstanceId ||
      !options.modelProviders ||
      !options.jobService
    ) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message:
              "缺少 providerInstanceId——请先在「设置 → 供应商」添加供应商实例后再发起生成。",
          },
        }),
      );
    }
    if (!payload.model) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "缺少 model（从实例模型清单中选择）。",
          },
        }),
      );
    }
    const model = payload.model;

    let releaseAdmission: (() => void) | undefined;
    try {
      releaseAdmission = options.localInstance.beginAdmission();
      await options.localInstance.resolve(user);
      if (!options.modelProviders || !payload.providerInstanceId)
        throw new Error("请先选择本地供应商实例。");
      await options.modelProviders.resolveCredentials(
        user,
        payload.providerInstanceId,
      );

      // ── Create job ──
      const job = await options.jobService.createJob(user, {
        jobType: "video_generation",
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        ...(payload.threadId ? { threadId: payload.threadId } : {}),
        payload: {
          prompt: payload.prompt,
          model,
          ...(payload.providerInstanceId
            ? { provider_instance_id: payload.providerInstanceId }
            : {}),
          ...(payload.duration != null ? { duration: payload.duration } : {}),
          ...(payload.resolution ? { resolution: payload.resolution } : {}),
          ...(payload.aspectRatio ? { aspect_ratio: payload.aspectRatio } : {}),
          ...(payload.inputImages?.length
            ? { input_images: payload.inputImages }
            : {}),
        },
      });

      // ── 异步受理（S6）：任务由 worker 执行（异步任务面 submit + 队列轮询），
      // HTTP 请求不在请求内挂起等结果（台账遗留：5 分钟内联轮询退役）。
      // 进度经 GET /api/jobs/:id 轮询。
      return reply.code(202).send({
        job_id: job.id,
        status: "queued",
        prompt: payload.prompt,
      });
    } catch (error) {
      if (error instanceof LocalInstanceMaintenanceError)
        return reply
          .code(503)
          .send({ error: { code: error.code, message: error.message } });
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }

      const message =
        error instanceof Error ? error.message : "Video generation failed.";

      return reply.code(502).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "generation_failed",
            message,
          },
        }),
      );
    } finally {
      releaseAdmission?.();
    }
  });
}

// ── Image download + upload helper ──────────────────────────

async function downloadAndUpload(
  sourceUrl: string,
  mimeType: string,
  prompt: string,
  user: LocalActor,
  deps: { uploadService: UploadService; localInstance: LocalInstanceService },
): Promise<{ signedUrl: string; assetId: string }> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download generated image: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const ext = mimeType === "image/webp" ? "webp" : "png";
  const slug = prompt
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const fileName = `gen-${slug}-${Date.now()}.${ext}`;

  // 验证本地实例；持久化使用同一个 LocalActor。
  await deps.localInstance.resolve(user);

  const result = await deps.uploadService.uploadFile(user, {
    bucket: "project-assets",
    fileName,
    fileBuffer: buffer,
    mimeType,
  });

  return { signedUrl: result.url, assetId: result.asset.id };
}
