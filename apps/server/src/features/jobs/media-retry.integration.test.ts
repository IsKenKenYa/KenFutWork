import { createServer } from "node:http";
import { ToolMessage } from "@langchain/core/messages";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { kernelToolToStructuredTool } from "../../agent/kernel-tools-bridge.js";
import { registerJobRoutes } from "../../http/jobs.js";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGenerationTargets } from "../generation/file-targets.js";
import {
  describeMediaJobWaitIssue,
  readMediaJobWaitIssue,
} from "../generation/media-job-wait.js";
import { createImageGenerateToolDefinition } from "../generation/tools/image-generate.js";
import { createModelProviderService } from "../model-providers/model-provider-service.js";
import { createModelProviderRepository } from "../model-providers/repository.js";
import { createInProcessQueue } from "../queue/providers/in-process.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createAssetWriter } from "../uploads/asset-writer.js";
import { createUploadRepository } from "../uploads/repository.js";
import { startJobLoop } from "./job-loop.js";
import { createJobService } from "./job-service.js";
import { createJobRepository } from "./repository.js";
import "./executors/image-generation.js";
import "./executors/video-generation.js";

const videoFailures = {
  input: [
    "InputAudioSensitiveContentDetected.PolicyViolation",
    "media_input_audio_copyright",
    "参考音频可能涉及版权限制，请更换音频。",
  ],
  output: [
    "OutputAudioSensitiveContentDetected.PolicyViolation",
    "media_output_audio_copyright",
    "生成的音频可能涉及版权限制，请调整提示词或参考素材。",
  ],
  constraint: [
    "InvalidParameter.TaskTypeConstraint",
    "media_task_type_constraint",
    "生成参数与模型识别的任务类型不兼容，请检查生成设置。",
  ],
  mismatch: [
    "InvalidParameter.TaskTypeMismatch",
    "media_task_type_mismatch",
    "模型识别的任务类型与请求不一致，请调整提示词和参考素材。",
  ],
  unknown: [
    "UnknownVendorFailure",
    "provider_task_failed",
    "供应商已确认生成失败，请核对供应商任务记录。",
  ],
} as const;

const localRefusals = {
  format: {
    protocol: "volces",
    model: "seedream-test",
    video: false,
    payload: { output_format: "webp" },
    code: "unsupported",
    diagnostic: "WebP",
    message: "生成服务不支持所选方式或参数，请调整设置或更换模型。",
  },
  audio: {
    protocol: "metaso",
    model: "metaso/minimax-h3",
    video: true,
    payload: { enable_audio: true },
    code: "unsupported_input",
    diagnostic: "audio generation",
    message: "生成服务不支持所选参考素材或音频选项，请修改设置或更换模型。",
  },
  model: {
    protocol: "metaso",
    model: "missing-model",
    video: true,
    payload: {},
    code: "model_not_found",
    diagnostic: "Unknown Metaso video model",
    message: "找不到所选模型，请在供应商设置中检查模型 ID。",
  },
} as const;

describe.skipIf(process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1")(
  "媒体Job实际HTTP错误与重试",
  () => {
    let db: Awaited<ReturnType<typeof createTaskWorkDatabase>>;
    beforeAll(async () => {
      db = await createTaskWorkDatabase();
    }, 30_000);
    afterAll(async () => {
      await db?.close();
    });
    async function fixture(
      mode:
        | "limited"
        | "auth"
        | "balance"
        | "lost"
        | keyof typeof localRefusals
        | keyof typeof videoFailures,
      rejectSubmission = false,
    ) {
      const submittedAt: number[] = [];
      const methods: string[] = [];
      const video = Object.hasOwn(videoFailures, mode)
        ? videoFailures[mode as keyof typeof videoFailures]
        : undefined;
      const local = Object.hasOwn(localRefusals, mode)
        ? localRefusals[mode as keyof typeof localRefusals]
        : undefined;
      const isVideo = Boolean(video || local?.video);
      const model = local?.model ?? (video ? "seedance-test" : "gpt-image-1");
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
          /* 消费模拟供应商输入 */
        }
        submittedAt.push(Date.now());
        methods.push(request.method ?? "");
        if (video) {
          response.statusCode = rejectSubmission ? 400 : 200;
          response.setHeader("content-type", "application/json");
          const error = {
            code: video[0],
            message:
              "内部内容 test-only OTHER-SECRET InputAudioSensitiveContentDetected.PolicyViolation",
          };
          response.end(
            JSON.stringify(
              rejectSubmission
                ? { error }
                : request.method === "POST"
                  ? { id: "accepted-video" }
                  : { id: "accepted-video", status: "failed", error },
            ),
          );
          return;
        }
        if (mode === "lost") {
          request.socket.destroy();
          return;
        }
        if (mode !== "limited" || submittedAt.length === 1) {
          response.statusCode = mode === "auth" ? 401 : 429;
          response.setHeader("content-type", "application/json");
          response.setHeader("retry-after", "0.2");
          response.end(
            JSON.stringify({
              error: {
                code:
                  mode === "auth"
                    ? "invalid_api_key"
                    : mode === "balance"
                      ? "insufficient_quota"
                      : "rate_limit_exceeded",
                message:
                  mode === "auth"
                    ? "模拟鉴权失败"
                    : mode === "balance"
                      ? "模拟余额不足"
                      : "模拟临时限流",
              },
            }),
          );
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: [
              {
                b64_json:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=",
              },
            ],
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("模拟供应商未启动");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const modelProviders = createModelProviderService({
        repository: createModelProviderRepository(db.persistence),
        localInstance: db.localInstance,
      });
      const provider = await modelProviders.createInstance(db.actor, {
        name: "重试模拟供应商",
        protocol: local?.protocol ?? (video ? "volces" : "openai-compatible"),
        baseUrl: `${baseUrl}${video ? "/api/v3" : "/v1"}`,
        apiKey: "test-only",
        ...(video ? { headers: { "x-private": "OTHER-SECRET" } } : {}),
        models: [
          {
            id: model,
            name: "回环模型",
            capability: isVideo ? "video" : "image",
          },
        ],
      });
      const queue = createInProcessQueue();
      const generationTargets = createGenerationTargets({
        persistence: db.persistence,
        executionScopes: createExecutionScopes({
          repository: createScopeRepository(db.persistence),
          localInstance: db.localInstance,
        }),
      });
      const jobs = createJobService({
        queue,
        generationTargets,
        repository: createJobRepository(db.persistence),
        localInstance: db.localInstance,
      });
      const input = {
        requestId: crypto.randomUUID(),
        jobType: isVideo
          ? ("video_generation" as const)
          : ("image_generation" as const),
        payload: {
          prompt: "猫",
          model,
          provider_instance_id: provider.id,
          ...local?.payload,
        },
      };
      const job = await jobs.createJob(db.actor, input);
      const app = Fastify();
      await registerJobRoutes(app, {
        localAccess: db.localAccess,
        localInstance: db.localInstance,
        jobService: jobs,
        modelProviders,
      });
      const loop = startJobLoop(
        {
          queue,
          jobService: jobs,
          generationTargets,
          modelProviders,
          blob: createLocalFsBlobStore({
            rootDir: `${db.directory}/retry-${job.id}`,
            publicBaseUrl: baseUrl,
            signingSecret: "test-only",
          }),
          assetWriter: createAssetWriter(
            createUploadRepository(db.persistence),
          ),
          projectFiles: {} as never,
          env: {
            agentBackendMode: "state",
            agentModel: "test",
            port: 0,
            version: "test",
            webOrigin: baseUrl,
            workerPollIntervalMs: 30_000,
            videoPollDelaySeconds: 1,
          },
        },
        {
          queues: [isVideo ? "video_generation_jobs" : "image_generation_jobs"],
        },
      );
      return {
        jobs,
        job,
        input,
        submittedAt,
        methods,
        read: (url: string) =>
          app.inject({
            method: "GET",
            url,
            headers: { authorization: `Bearer ${db.desktopToken}` },
          }),
        async close() {
          await loop.shutdown();
          await app.close();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        },
      };
    }
    it.each(["format", "audio", "model"] as const)(
      "本机适配器拒绝 %s 后，查询、重放和模型提示保留可操作原因",
      async (mode) => {
        const expected = localRefusals[mode];
        const f = await fixture(mode);
        try {
          await vi.waitFor(
            async () =>
              expect(await f.jobs.getJobForWorker(f.job.id)).toMatchObject({
                status: "dead_letter",
                error_code: expected.code,
              }),
            { timeout: 4000 },
          );
          const record = await f.jobs.getJobForWorker(f.job.id);
          expect(record.error_message).toContain(expected.diagnostic);
          expect(record.attempt_count).toBe(1);
          expect(record.provider_job_id).toBeNull();
          const publicFailure = {
            id: f.job.id,
            status: "dead_letter",
            error_code: expected.code,
            error_message: expected.message,
          };
          const detail = await f.read(`/api/jobs/${f.job.id}`);
          expect(detail.statusCode).toBe(200);
          expect(detail.json().job).toMatchObject(publicFailure);
          const list = await f.read(
            `/api/jobs?request_id=${f.input.requestId}`,
          );
          expect(list.statusCode).toBe(200);
          expect(list.json().jobs).toMatchObject([publicFailure]);
          expect(await f.jobs.createJob(db.actor, f.input)).toMatchObject(
            publicFailure,
          );
          const issue = readMediaJobWaitIssue(record);
          if (!issue) throw new Error("工具应读取到已保存的适配器拒绝");
          expect(describeMediaJobWaitIssue(issue)).toMatchObject({
            isError: true,
            errorCode: expected.code,
            error: expected.message,
          });
          expect(f.methods).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      ["input", true],
      ["input", false],
      ["output", false],
      ["constraint", true],
      ["mismatch", false],
      ["unknown", false],
    ] as const)(
      "视频 %s（提交拒绝=%s）从真实供应商协议、持久任务到公开接口保留原因",
      async (mode, rejectSubmission) => {
        const f = await fixture(mode, rejectSubmission);
        try {
          const [source, code, message] = videoFailures[mode];
          await vi.waitFor(
            async () =>
              expect(await f.jobs.getJobForWorker(f.job.id)).toMatchObject({
                status: "dead_letter",
              }),
            { timeout: 4000 },
          );
          const record = await f.jobs.getJobForWorker(f.job.id);
          expect(record.error_message).toContain(source);
          expect(record.error_message).toContain("内部内容");
          expect(record.error_message).not.toContain("test-only");
          expect(record.error_message).not.toContain("OTHER-SECRET");
          expect(record.provider_job_id !== null).toBe(!rejectSubmission);
          const response = await f.read(`/api/jobs/${f.job.id}`);
          expect(response.statusCode).toBe(200);
          expect(response.json().job).toMatchObject({
            status: "dead_letter",
            error_code: code,
            error_message: message,
          });
          expect(response.body).not.toContain("内部内容");
          expect(response.body).not.toContain(source);
          const issue = readMediaJobWaitIssue(record);
          if (!issue) throw new Error("工具应读到已持久化的失败");
          expect(describeMediaJobWaitIssue(issue)).toMatchObject({
            isError: true,
            errorCode: code,
            error: message,
          });
          expect(f.methods).toEqual(
            rejectSubmission ? ["POST"] : ["POST", "GET"],
          );
        } finally {
          await f.close();
        }
      },
    );
    it("429优先遵守Retry-After，恢复原Job并由引擎单次重发", async () => {
      const f = await fixture("limited");
      try {
        await vi.waitFor(
          async () =>
            expect((await f.jobs.getJob(db.actor, f.job.id)).status).toBe(
              "succeeded",
            ),
          { timeout: 4000 },
        );
        expect(f.submittedAt).toHaveLength(2);
        expect(
          (f.submittedAt[1] ?? 0) - (f.submittedAt[0] ?? 0),
        ).toBeGreaterThanOrEqual(180);
        expect((f.submittedAt[1] ?? 0) - (f.submittedAt[0] ?? 0)).toBeLessThan(
          3000,
        );
        expect((await f.jobs.getJob(db.actor, f.job.id)).attempt_count).toBe(1);
        const reply = await f.read(`/api/jobs/${f.job.id}`);
        expect(reply.statusCode).toBe(200);
        expect(reply.json().job).toMatchObject({
          status: "succeeded",
          error_code: null,
          error_message: null,
        });
      } finally {
        await f.close();
      }
    });
    it.each(["auth", "balance"] as const)(
      "%s明确拒绝立即反馈原因，不再次请求",
      async (mode) => {
        const f = await fixture(mode);
        try {
          await vi.waitFor(
            async () =>
              expect((await f.jobs.getJob(db.actor, f.job.id)).status).toBe(
                "dead_letter",
              ),
            { timeout: 4000 },
          );
          expect(
            (await f.jobs.getJobForWorker(f.job.id)).error_message,
          ).toContain(mode === "auth" ? "模拟鉴权失败" : "模拟余额不足");
          const expected = {
            id: f.job.id,
            status: "dead_letter",
            error_code:
              mode === "auth"
                ? "provider_auth_failed"
                : "provider_balance_insufficient",
            error_message:
              mode === "auth"
                ? "供应商拒绝访问，请在供应商设置中检查密钥和权限。"
                : "供应商额度不足，请检查账户余额。",
          };
          const detail = await f.read(`/api/jobs/${f.job.id}`);
          expect(detail.statusCode).toBe(200);
          expect(detail.json().job).toMatchObject(expected);
          const list = await f.read(
            `/api/jobs?request_id=${f.input.requestId}`,
          );
          expect(list.statusCode).toBe(200);
          expect(list.json().jobs).toMatchObject([expected]);
          const replay = await f.jobs.createJob(db.actor, f.input);
          expect(replay).toMatchObject(expected);
          expect(`${detail.body}${list.body}`).not.toContain(
            mode === "auth" ? "模拟鉴权失败" : "模拟余额不足",
          );
          expect(f.submittedAt).toHaveLength(1);
        } finally {
          await f.close();
        }
      },
    );
    it("上游收到请求后断开回执，只标待确认；同请求重放不会重复生成", async () => {
      const f = await fixture("lost");
      try {
        await vi.waitFor(
          async () =>
            expect(await f.jobs.getJob(db.actor, f.job.id)).toMatchObject({
              status: "failed",
              error_code: "submission_unknown",
            }),
          { timeout: 4000 },
        );
        expect(await f.jobs.createJob(db.actor, f.input)).toMatchObject({
          id: f.job.id,
          status: "failed",
        });
        const record = await f.jobs.getJob(db.actor, f.job.id);
        const definition = createImageGenerateToolDefinition({
          submitImageJob: async () => {
            const issue = readMediaJobWaitIssue(record);
            if (!issue) throw new Error("工具应立即获知提交结果待确认");
            return { jobId: record.id, issue };
          },
        });
        const result = await kernelToolToStructuredTool(definition).invoke({
          type: "tool_call",
          name: definition.name,
          id: "media-unknown",
          args: { title: "测试图片", prompt: "猫", model: "gpt-image-1" },
        });
        expect(ToolMessage.isInstance(result)).toBe(true);
        expect(result.status).toBe("error");
        if (typeof result.content !== "string")
          throw new Error("工具没有返回可读取的任务状态");
        expect(JSON.parse(result.content)).toMatchObject({
          jobStatus: "submission_unknown",
          errorCode: "submission_unknown",
          error: "提交结果待确认，请核对供应商记录。",
        });
        expect(result.content).not.toContain("仍在生成");
        expect(f.submittedAt).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
  },
);
