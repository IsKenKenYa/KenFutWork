import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerGenerateRoutes } from "../../http/generate.js";
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

it
  .skipIf(process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1")
  .each(["complete", "local-cancel"])(
  "GRSAI驱动接入共享HTTP/Job、恢复与本地取消：%s",
  async (mode) => {
    const db = await createTaskWorkDatabase();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=",
      "base64",
    );
    let submissions = 0,
      queries = 0,
      completed = false;
    const bodies: Record<string, unknown>[] = [];
    const downloads: Array<string | undefined> = [];
    let baseUrl = "";
    const supplier = createServer(async (request, response) => {
      if (request.url === "/output.png") {
        downloads.push(request.headers.authorization);
        response.setHeader("content-type", "image/png");
        response.end(png);
        return;
      }
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/v1/api/generate") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        bodies.push(JSON.parse(body));
        submissions++;
        response.end(
          JSON.stringify({ id: "durable-grsai-task", status: "running" }),
        );
        return;
      }
      if (request.url === "/v1/api/result?id=durable-grsai-task") {
        queries++;
        response.end(
          JSON.stringify(
            completed
              ? {
                  id: "durable-grsai-task",
                  status: "succeeded",
                  results: [{ url: `${baseUrl}/output.png` }],
                }
              : { id: "durable-grsai-task", status: "running" },
          ),
        );
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    const app = Fastify();
    let closeLoop = async () => {};
    const queues: Array<ReturnType<typeof createInProcessQueue>> = [];
    try {
      await new Promise<void>((resolve) =>
        supplier.listen(0, "127.0.0.1", resolve),
      );
      const address = supplier.address();
      if (!address || typeof address === "string")
        throw new Error("模拟供应商未启动");
      baseUrl = `http://127.0.0.1:${address.port}`;
      const blob = createLocalFsBlobStore({
        rootDir: `${db.directory}/driver-blobs`,
        signingSecret: "test-only",
        publicBaseUrl: "http://127.0.0.1:1",
      });
      const uploads = createUploadService({
        blob,
        repository: createUploadRepository(db.persistence),
        localInstance: db.localInstance,
      });
      const targets = createGenerationTargets({
        persistence: db.persistence,
        executionScopes: createExecutionScopes({
          repository: createScopeRepository(db.persistence),
          localInstance: db.localInstance,
        }),
      });
      const providers = createModelProviderService({
        repository: createModelProviderRepository(db.persistence),
        localInstance: db.localInstance,
      });
      const instance = await providers.createInstance(db.actor, {
        name: "独立GRSAI驱动",
        protocol: "grsai",
        baseUrl,
        apiKey: "test-only-secret",
        models: [
          {
            id: "nano-banana-2",
            name: "我的图片",
            capability: "image",
            imageGeneration: {
              qualities: ["1K"],
              outputFormats: [],
              maxOutputs: 1,
            },
          },
        ],
      });
      const makeRuntime = () => {
        const queue = createInProcessQueue();
        queues.push(queue);
        const jobs = createJobService({
          queue,
          uploads,
          repository: createJobRepository(db.persistence),
          localInstance: db.localInstance,
          generationTargets: targets,
        });
        return {
          jobs,
          context: {
            queue,
            uploads,
            jobService: jobs,
            blob,
            generationTargets: targets,
            projectFiles: {} as never,
            assetWriter: createAssetWriter(
              createUploadRepository(db.persistence),
            ),
            modelProviders: providers,
            env: {
              agentBackendMode: "state" as const,
              agentModel: "test",
              port: 0,
              version: "test",
              webOrigin: baseUrl,
              workerPollIntervalMs: 50,
            },
          },
        };
      };
      const first = makeRuntime();
      await registerGenerateRoutes(app, {
        localAccess: db.localAccess,
        localInstance: db.localInstance,
        jobService: first.jobs,
        modelProviders: providers,
      });
      const payload = {
        requestId: randomUUID(),
        providerInstanceId: instance.id,
        model: "nano-banana-2",
        prompt: "纸鹤",
        quality: "1K",
        inputImages: [`data:image/png;base64,${png.toString("base64")}`],
      };
      const accepted = await app.inject({
        method: "POST",
        url: "/api/agent/generate-image",
        headers: { authorization: `Bearer ${db.desktopToken}` },
        payload,
      });
      expect(accepted.statusCode).toBe(202);
      const jobId = accepted.json().jobs[0].job_id as string;
      const loop = startJobLoop(first.context, {
        queues: ["image_generation_jobs"],
      });
      closeLoop = () => loop.shutdown();
      await vi.waitFor(
        async () =>
          expect(await first.jobs.getJob(db.actor, jobId)).toMatchObject({
            provider_job_id: "durable-grsai-task",
          }),
        { timeout: 5000 },
      );
      if (mode === "local-cancel") {
        await first.jobs.cancelJob(db.actor, jobId);
        await vi.waitFor(
          async () =>
            expect(await first.jobs.getJob(db.actor, jobId)).toMatchObject({
              status: "canceled",
              payload: { _generation_cancel: { state: "local_only" } },
            }),
          { timeout: 5000 },
        );
        expect(submissions).toBe(1);
        expect(downloads).toEqual([]);
        expect(
          (await first.jobs.getJob(db.actor, jobId)).result?.outputs ?? [],
        ).toEqual([]);
        return;
      }
      await closeLoop();
      completed = true;
      const second = makeRuntime();
      const recovered = startJobLoop(second.context, {
        queues: ["image_generation_jobs"],
      });
      closeLoop = () => recovered.shutdown();
      await vi.waitFor(
        async () =>
          expect(await second.jobs.getJob(db.actor, jobId)).toMatchObject({
            status: "succeeded",
          }),
        { timeout: 15000 },
      );
      const final = await second.jobs.getJob(db.actor, jobId);
      expect(submissions).toBe(1);
      expect(queries).toBeGreaterThan(0);
      expect(bodies).toEqual([
        {
          model: "nano-banana-2",
          prompt: "纸鹤",
          replyType: "async",
          imageSize: "1K",
          images: [png.toString("base64")],
        },
      ]);
      expect(JSON.stringify(final.payload)).not.toContain("test-only-secret");
      expect(JSON.stringify(final.payload)).not.toContain(
        png.toString("base64"),
      );
      expect(final.result?.outputs).toHaveLength(1);
      expect(final.result?.outputs?.[0]).toMatchObject({ width: 1, height: 1 });
      expect(downloads).toEqual([undefined]);
      const output = final.result?.outputs?.[0];
      if (!output) throw new Error("产物未保存");
      expect(
        Buffer.from(
          await blob.bucket("project-assets").download(output.object_path),
        ),
      ).toEqual(png);
      const replay = await app.inject({
        method: "POST",
        url: "/api/agent/generate-image",
        headers: { authorization: `Bearer ${db.desktopToken}` },
        payload,
      });
      expect(replay.json().jobs[0].job_id).toBe(jobId);
      expect(submissions).toBe(1);
    } finally {
      await closeLoop();
      await app.close();
      for (const queue of queues) await queue.shutdown();
      await new Promise<void>((resolve, reject) =>
        supplier.close((error) => (error ? reject(error) : resolve())),
      );
      await db.close();
    }
  },
  40000,
);
