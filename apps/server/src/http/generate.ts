import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  type BackgroundJob,
  type GenerateImageRequest,
  type GenerateVideoRequest,
  generateImageRequestSchema,
  generateVideoRequestSchema,
  generationSubmissionSchema,
  hasImageGenerationInput,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { JobService } from "../features/jobs/job-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { LocalInstanceMaintenanceError } from "../features/local-instance/service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../features/local-instance/types.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import { resolveInstanceImageProvider } from "../providers/resolve.js";

type GenerateOptions = {
  localAccess: LocalAccessVerifier;
  jobService?: JobService;
  modelProviders?: ModelProviderService;
  localInstance: LocalInstanceService;
};
type MediaRequest = GenerateImageRequest | GenerateVideoRequest;
const PARAM_NAMES: Readonly<Record<string, string>> = {
  count: "count",
  aspectRatio: "aspect_ratio",
  quality: "quality",
  width: "width",
  height: "height",
  outputFormat: "output_format",
  inputImages: "input_images",
  inputVideo: "input_video",
  enableAudio: "enable_audio",
  resolution: "resolution",
  duration: "duration",
  generatorId: "generator_id",
  placement: "placement",
};

function jobPayload(payload: MediaRequest): Record<string, unknown> {
  const result: Record<string, unknown> = {
    prompt: payload.prompt,
    model: payload.model,
    provider_instance_id: payload.providerInstanceId,
  };
  for (const [name, value] of Object.entries(payload)) {
    const key = PARAM_NAMES[name];
    if (key && value !== undefined) result[key] = value;
  }
  return result;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply
    .code(status)
    .send(applicationErrorResponseSchema.parse({ error: { code, message } }));
}

async function acceptGeneration(
  actor: LocalActor,
  payload: MediaRequest,
  kind: "image" | "video",
  options: GenerateOptions & {
    jobService: JobService;
    modelProviders: ModelProviderService;
  },
) {
  const release = options.localInstance.beginAdmission();
  try {
    await options.localInstance.resolve(actor);
    if (!payload.providerInstanceId)
      throw new JobServiceError(
        "job_create_failed",
        "请先选择供应商和模型。",
        400,
      );
    const credentials = await options.modelProviders.resolveCredentials(
      actor,
      payload.providerInstanceId,
    );
    const requestId = payload.requestId ?? randomUUID();
    const input = {
      interactiveRequest: true as const,
      requestId,
      ...(payload.projectId ? { projectId: payload.projectId } : {}),
      ...(payload.canvasId ? { canvasId: payload.canvasId } : {}),
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
      jobType:
        kind === "image"
          ? ("image_generation" as const)
          : ("video_generation" as const),
      payload: jobPayload(payload),
    };
    let jobs: BackgroundJob[];
    if (kind === "image") {
      const imageRequest = payload as GenerateImageRequest;
      const model = credentials.models.find(
        (candidate) => candidate.id === payload.model,
      );
      const provider = resolveInstanceImageProvider(credentials.protocol, {
        credentials: {
          apiKey: credentials.apiKey,
          ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
        },
        models: [{ id: payload.model, name: model?.name ?? payload.model }],
      });
      const limit = provider.generateMany
        ? (model?.imageGeneration?.maxOutputs ?? 1)
        : 1;
      const counts = Array.from(
        { length: Math.ceil(imageRequest.count / limit) },
        (_, index) => Math.min(limit, imageRequest.count - index * limit),
      );
      jobs = await options.jobService.createJobs(actor, input, counts, () => {
        if (
          !hasImageGenerationInput(
            imageRequest.prompt,
            imageRequest.inputImages,
            model?.imageGeneration,
          )
        )
          throw new JobServiceError(
            "job_create_failed",
            "请输入提示词；无需提示词的模型请添加参考图。",
            400,
          );
      });
    } else jobs = [await options.jobService.createJob(actor, input)];
    return generationSubmissionSchema.parse({
      request_id: requestId,
      jobs: jobs.map((job) => ({ job_id: job.id, status: job.status })),
    });
  } finally {
    release();
  }
}

function createGenerateHandler(
  kind: "image" | "video",
  options: GenerateOptions,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor)
      return sendError(reply, 401, "unauthorized", "本机接入凭据缺失或无效。");
    const parsed = (
      kind === "image" ? generateImageRequestSchema : generateVideoRequestSchema
    ).safeParse(request.body);
    if (!parsed.success)
      return sendError(
        reply,
        400,
        "invalid_request",
        "生成参数无效，请检查模型与输入素材。",
      );
    if (!options.jobService || !options.modelProviders)
      return sendError(
        reply,
        503,
        "service_unavailable",
        "生成服务未配置，请检查实例设置。",
      );
    if (!parsed.data.providerInstanceId)
      return sendError(
        reply,
        400,
        "invalid_request",
        "请先在供应商设置中添加并选择模型。",
      );
    try {
      return reply.code(202).send(
        await acceptGeneration(actor, parsed.data, kind, {
          ...options,
          jobService: options.jobService,
          modelProviders: options.modelProviders,
        }),
      );
    } catch (error) {
      if (error instanceof LocalInstanceMaintenanceError)
        return sendError(reply, 503, error.code, error.message);
      if (error instanceof JobServiceError)
        return sendError(reply, error.statusCode, error.code, error.message);
      return sendError(
        reply,
        502,
        "generation_failed",
        "生成任务受理失败，请稍后重试。",
      );
    }
  };
}

export async function registerGenerateRoutes(
  app: FastifyInstance,
  options: GenerateOptions,
) {
  app.post(
    "/api/agent/generate-image",
    createGenerateHandler("image", options),
  );
  app.post(
    "/api/agent/generate-video",
    createGenerateHandler("video", options),
  );
}
