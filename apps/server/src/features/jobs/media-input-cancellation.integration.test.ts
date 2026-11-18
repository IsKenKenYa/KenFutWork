import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGenerationTargets } from "../generation/file-targets.js";
import { createModelProviderService } from "../model-providers/model-provider-service.js";
import { createModelProviderRepository } from "../model-providers/repository.js";
import { createInProcessQueue } from "../queue/providers/in-process.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createAssetWriter } from "../uploads/asset-writer.js";
import { createUploadRepository } from "../uploads/repository.js";
import { createUploadService } from "../uploads/upload-service.js";
import { startJobLoop } from "./job-loop.js";
import { createJobService } from "./job-service.js";
import { createJobRepository } from "./repository.js";
import "./executors/image-generation.js";

describe.skipIf(process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1")(
  "生成参考素材准备与取消",
  () => {
    let db: Awaited<ReturnType<typeof createTaskWorkDatabase>>;
    beforeAll(async () => {
      db = await createTaskWorkDatabase();
    }, 30_000);
    afterAll(async () => {
      await db?.close();
    });

    it("Replicate参考图上传期间取消，释放上传后不提交付费预测", async () => {
      let uploads = 0;
      let predictions = 0;
      let releaseUpload: () => void = () => {};
      const heldUpload = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      let baseUrl = "";
      const upstream = createServer(async (request, response) => {
        for await (const _chunk of request) {
          /* 读取真实HTTP请求体 */
        }
        response.setHeader("content-type", "application/json");
        if (request.url === "/v1/files") {
          uploads++;
          await heldUpload;
          response.end(
            JSON.stringify({ urls: { get: `${baseUrl}/reference.png` } }),
          );
          return;
        }
        if (request.method === "POST") predictions++;
        response.end(
          JSON.stringify({
            id: "unexpected-prediction",
            status: "processing",
            output: null,
          }),
        );
      });
      const queue = createInProcessQueue();
      let loop: ReturnType<typeof startJobLoop> | undefined;
      try {
        await new Promise<void>((resolve) =>
          upstream.listen(0, "127.0.0.1", resolve),
        );
        const address = upstream.address();
        if (!address || typeof address === "string")
          throw new Error("模拟供应商未启动");
        baseUrl = `http://127.0.0.1:${address.port}`;
        const blob = createLocalFsBlobStore({
          rootDir: `${db.directory}/cancel-upload`,
          signingSecret: "test-only",
          publicBaseUrl: baseUrl,
        });
        const uploadRepository = createUploadRepository(db.persistence);
        const uploadService = createUploadService({
          blob,
          repository: uploadRepository,
          localInstance: db.localInstance,
        });
        const generationTargets = createGenerationTargets({
          persistence: db.persistence,
          executionScopes: createExecutionScopes({
            repository: createScopeRepository(db.persistence),
            localInstance: db.localInstance,
          }),
        });
        const jobs = createJobService({
          queue,
          repository: createJobRepository(db.persistence),
          localInstance: db.localInstance,
          generationTargets,
          uploads: uploadService,
        });
        const models = createModelProviderService({
          repository: createModelProviderRepository(db.persistence),
          localInstance: db.localInstance,
        });
        const configured = await models.createInstance(db.actor, {
          name: "上传取消回归",
          protocol: "replicate",
          apiKey: "test-only",
          baseUrl: `${baseUrl}/v1`,
          models: [
            {
              id: "custom-owner/custom-image",
              name: "图片",
              capability: "image",
            },
          ],
        });
        const accepted = await jobs.createJob(db.actor, {
          requestId: randomUUID(),
          jobType: "image_generation",
          payload: {
            prompt: "猫",
            model: "custom-owner/custom-image",
            provider_instance_id: configured.id,
            input_images: [
              `data:image/png;base64,${Buffer.alloc(1_000_001, 0x5a).toString("base64")}`,
            ],
          },
        });
        loop = startJobLoop(
          {
            queue,
            jobService: jobs,
            modelProviders: models,
            generationTargets,
            uploads: uploadService,
            assetWriter: createAssetWriter(uploadRepository),
            blob,
            projectFiles: {} as never,
            env: {
              agentBackendMode: "state",
              agentModel: "test",
              port: 0,
              version: "test",
              webOrigin: baseUrl,
              workerPollIntervalMs: 1000,
            },
          },
          { queues: ["image_generation_jobs"] },
        );
        await vi.waitFor(() => expect(uploads).toBe(1), { timeout: 3000 });
        expect(predictions).toBe(0);
        const preparing = await jobs.getJob(db.actor, accepted.id);
        expect(preparing.payload._generation_execution).toMatchObject({
          phase: "ready",
        });
        await jobs.cancelJob(db.actor, accepted.id);
        releaseUpload();
        await vi.waitFor(
          async () =>
            expect(await jobs.getJob(db.actor, accepted.id)).toMatchObject({
              status: "canceled",
              provider_job_id: null,
              result: null,
              payload: { _generation_cancel: { state: "local_only" } },
            }),
          { timeout: 4000 },
        );
        await vi.waitFor(() => expect(loop?.inFlightCount()).toBe(0));
        expect(predictions).toBe(0);
        expect(uploads).toBe(1);
      } finally {
        releaseUpload();
        await loop?.shutdown();
        if (!loop) await queue.shutdown();
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 15_000);
  },
);
