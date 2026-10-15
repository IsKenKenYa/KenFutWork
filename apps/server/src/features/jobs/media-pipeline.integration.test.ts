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
import { createUsageRepository } from "../usage/repository.js";
import { createUsageService } from "../usage/usage-service.js";
import { startJobLoop } from "./job-loop.js";
import { createJobService } from "./job-service.js";
import { createJobRepository } from "./repository.js";
import "./executors/image-generation.js";

describe.skipIf(process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1")(
  "媒体产物真实数据库流水线",
  () => {
    let db: Awaited<ReturnType<typeof createTaskWorkDatabase>>;
    beforeAll(async () => {
      db = await createTaskWorkDatabase();
    }, 30_000);
    afterAll(async () => {
      await db?.close();
    });

    it.each(["url", "inline", "download-failed"])(
      "供应商只生成一次，%s产物恢复与用量不丢失",
      async (mode) => {
        let submits = 0;
        let downloads = 0;
        let baseUrl = "";
        const provider = createServer(async (request, response) => {
          if (request.method === "POST") {
            for await (const _chunk of request) {
              /* 消费模拟供应商请求体 */
            }
            submits++;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                data: [
                  mode === "inline"
                    ? {
                        b64_json:
                          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=",
                      }
                    : { url: `${baseUrl}/image.png` },
                ],
              }),
            );
          } else {
            downloads++;
            if (mode === "download-failed" || downloads > 1) {
              response.statusCode = mode === "download-failed" ? 503 : 410;
              response.end("upstream image unavailable");
              return;
            }
            response.setHeader("content-type", "image/png");
            response.end(
              Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=",
                "base64",
              ),
            );
          }
        });
        await new Promise<void>((resolve) =>
          provider.listen(0, "127.0.0.1", resolve),
        );
        const address = provider.address();
        if (!address || typeof address === "string")
          throw new Error("模拟供应商未启动");
        baseUrl = `http://127.0.0.1:${address.port}`;
        const backing = createLocalFsBlobStore({
          rootDir: `${db.directory}/pipeline-output`,
          signingSecret: "test-only",
          publicBaseUrl: baseUrl,
        });
        let failReceipt = true;
        const blob = {
          ...backing,
          bucket(name: string) {
            const bucket = backing.bucket(name);
            return {
              ...bucket,
              async resolveUrl(path: string) {
                if (failReceipt) {
                  failReceipt = false;
                  throw new Error("模拟文件已保存但回执丢失");
                }
                return bucket.resolveUrl(path);
              },
            };
          },
        };
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
          repository: createJobRepository(db.persistence),
          localInstance: db.localInstance,
          generationTargets,
        });
        const usage = createUsageService({
          repository: createUsageRepository(db.persistence),
          localInstance: db.localInstance,
        });
        const modelProviders = createModelProviderService({
          repository: createModelProviderRepository(db.persistence),
          localInstance: db.localInstance,
        });
        const configured = await modelProviders.createInstance(db.actor, {
          name: "本地模拟供应商",
          apiKey: "test-only",
          baseUrl: `${baseUrl}/v1`,
          protocol: "openai-compatible",
          models: [
            { id: "gpt-image-1", name: "模拟图片模型", capability: "image" },
          ],
        });
        const priorCost = (await usage.summarize(db.actor)).totals.costUsd ?? 0;
        let failUsageReceipt = mode === "url" || mode === "inline";
        const usagePort = {
          ...usage,
          record: (entry: Parameters<typeof usage.record>[0]) =>
            Promise.all(
              Array.from({ length: 8 }, () =>
                usage.record({ ...entry, costUsd: 0.125 }),
              ),
            ).then(() => {
              if (failUsageReceipt) {
                failUsageReceipt = false;
                throw new Error("模拟用量已写入但回执丢失");
              }
            }),
        };
        const job = await jobs.createJob(db.actor, {
          requestId: randomUUID(),
          jobType: "image_generation",
          payload: {
            prompt: "猫",
            model: "gpt-image-1",
            provider_instance_id: configured.id,
          },
        });
        const loop = startJobLoop(
          {
            queue,
            jobService: jobs,
            blob,
            generationTargets,
            projectFiles: {} as never,
            assetWriter: createAssetWriter(
              createUploadRepository(db.persistence),
            ),
            usageService: usagePort,
            modelProviders,
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
        try {
          await vi.waitFor(
            async () =>
              expect(await jobs.getJob(db.actor, job.id)).toMatchObject({
                status:
                  mode === "download-failed" ? "dead_letter" : "succeeded",
                ...(mode !== "download-failed"
                  ? { result: { asset_id: job.id } }
                  : {}),
              }),
            { timeout: 12000 },
          );
          expect(submits).toBe(1);
          expect(downloads).toBe(
            mode === "inline" ? 0 : mode === "download-failed" ? 3 : 1,
          );
          const final = await jobs.getJob(db.actor, job.id);
          expect(JSON.stringify(final.payload)).not.toContain("base64,");
          expect(
            ((await usage.summarize(db.actor)).totals.costUsd ?? 0) - priorCost,
          ).toBe(0.125);
        } finally {
          await loop.shutdown();
          await new Promise<void>((resolve, reject) =>
            provider.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );

    it("原生多图只提交一次，实际少于请求数量时保留全部产物且不补发", async () => {
      const requests: Array<Record<string, unknown>> = [];
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=";
      const provider = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        requests.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ data: [{ b64_json: png }, { b64_json: png }] }),
        );
      });
      await new Promise<void>((resolve) =>
        provider.listen(0, "127.0.0.1", resolve),
      );
      const address = provider.address();
      if (!address || typeof address === "string")
        throw new Error("模拟供应商未启动");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const blob = createLocalFsBlobStore({
        rootDir: `${db.directory}/pipeline-many-output`,
        signingSecret: "test-only",
        publicBaseUrl: baseUrl,
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
        repository: createJobRepository(db.persistence),
        localInstance: db.localInstance,
        generationTargets,
      });
      const modelProviders = createModelProviderService({
        repository: createModelProviderRepository(db.persistence),
        localInstance: db.localInstance,
      });
      const configured = await modelProviders.createInstance(db.actor, {
        name: "本地多图模拟供应商",
        apiKey: "test-only",
        baseUrl: `${baseUrl}/v1`,
        protocol: "openai-compatible",
        models: [
          {
            id: "gpt-image-1",
            name: "原生多图模型",
            capability: "image",
            imageGeneration: { maxOutputs: 3 },
          },
        ],
      });
      const job = await jobs.createJob(db.actor, {
        requestId: randomUUID(),
        jobType: "image_generation",
        payload: {
          prompt: "两只猫",
          model: "gpt-image-1",
          provider_instance_id: configured.id,
          count: 3,
        },
      });
      const loop = startJobLoop(
        {
          queue,
          jobService: jobs,
          blob,
          generationTargets,
          projectFiles: {} as never,
          assetWriter: createAssetWriter(
            createUploadRepository(db.persistence),
          ),
          modelProviders,
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
      try {
        await vi.waitFor(
          async () =>
            expect(await jobs.getJob(db.actor, job.id)).toMatchObject({
              status: "succeeded",
            }),
          { timeout: 12000 },
        );
        const final = await jobs.getJob(db.actor, job.id);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ model: "gpt-image-1", n: 3 });
        expect(final.result).toMatchObject({
          asset_id: job.id,
          outputs: [
            { asset_id: job.id, mime_type: "image/png" },
            { mime_type: "image/png" },
          ],
        });
        const outputs = final.result?.outputs as Array<{ asset_id: string }>;
        expect(new Set(outputs.map((output) => output.asset_id)).size).toBe(2);
        expect(JSON.stringify(final.payload)).not.toContain(png);
      } finally {
        await loop.shutdown();
        await new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });

    it.each(["download", "inline-checkpoint"])(
      "多图中间产物%s失败仍保存前后产物，不重复生成并在失败回执展示成功结果",
      async (mode) => {
        let submits = 0;
        let baseUrl = "";
        const downloads = new Map<string, number>();
        const png =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=";
        const middlePng =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
        const provider = createServer(async (request, response) => {
          if (request.method === "POST") {
            for await (const _chunk of request) {
              /* 消费请求体 */
            }
            submits++;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                data:
                  mode === "download"
                    ? ["first", "middle", "last"].map((name) => ({
                        url: `${baseUrl}/${name}.png`,
                      }))
                    : [
                        { b64_json: png },
                        { b64_json: middlePng },
                        { b64_json: png },
                      ],
              }),
            );
            return;
          }
          const path = request.url ?? "/";
          downloads.set(path, (downloads.get(path) ?? 0) + 1);
          if (path === "/middle.png") {
            response.statusCode = 503;
            response.end("middle image unavailable");
            return;
          }
          response.setHeader("content-type", "image/png");
          response.end(Buffer.from(png, "base64"));
        });
        await new Promise<void>((resolve) =>
          provider.listen(0, "127.0.0.1", resolve),
        );
        const address = provider.address();
        if (!address || typeof address === "string")
          throw new Error("模拟供应商未启动");
        baseUrl = `http://127.0.0.1:${address.port}`;
        const backing = createLocalFsBlobStore({
          rootDir: `${db.directory}/pipeline-partial-${mode}`,
          signingSecret: "test-only",
          publicBaseUrl: baseUrl,
        });
        const blob = {
          ...backing,
          bucket(name: string) {
            const bucket = backing.bucket(name);
            return {
              ...bucket,
              async upload(...args: Parameters<typeof bucket.upload>) {
                if (
                  mode === "inline-checkpoint" &&
                  Buffer.compare(
                    Buffer.from(args[1]),
                    Buffer.from(middlePng, "base64"),
                  ) === 0
                )
                  throw new Error("模拟中间产物暂存失败");
                await bucket.upload(...args);
              },
            };
          },
        };
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
          repository: createJobRepository(db.persistence),
          localInstance: db.localInstance,
          generationTargets,
        });
        const modelProviders = createModelProviderService({
          repository: createModelProviderRepository(db.persistence),
          localInstance: db.localInstance,
        });
        const configured = await modelProviders.createInstance(db.actor, {
          name: "部分成功模拟供应商",
          apiKey: "test-only",
          baseUrl: `${baseUrl}/v1`,
          protocol: "openai-compatible",
          models: [
            {
              id: "gpt-image-1",
              name: "多图模型",
              capability: "image",
              imageGeneration: { maxOutputs: 3 },
            },
          ],
        });
        const job = await jobs.createJob(db.actor, {
          requestId: randomUUID(),
          jobType: "image_generation",
          payload: {
            prompt: "三只猫",
            model: "gpt-image-1",
            provider_instance_id: configured.id,
            count: 3,
          },
        });
        const loop = startJobLoop(
          {
            queue,
            jobService: jobs,
            blob,
            generationTargets,
            projectFiles: {} as never,
            assetWriter: createAssetWriter(
              createUploadRepository(db.persistence),
            ),
            modelProviders,
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
        try {
          await vi.waitFor(
            async () =>
              expect(await jobs.getJob(db.actor, job.id)).toMatchObject({
                status: "dead_letter",
                result: {
                  asset_id: job.id,
                  outputs: [{ asset_id: job.id }, { mime_type: "image/png" }],
                },
              }),
            { timeout: 15000 },
          );
          const final = await jobs.getJob(db.actor, job.id);
          const outputs = final.result?.outputs as Array<{
            asset_id: string;
            object_path: string;
          }>;
          expect(submits).toBe(1);
          expect(new Set(outputs.map((output) => output.asset_id)).size).toBe(
            2,
          );
          for (const output of outputs)
            expect(
              await backing
                .bucket("project-assets")
                .download(output.object_path),
            ).toEqual(new Uint8Array(Buffer.from(png, "base64")));
          if (mode === "download") {
            expect(downloads.get("/first.png")).toBe(1);
            expect(downloads.get("/last.png")).toBe(1);
            expect(downloads.get("/middle.png")).toBe(3);
          }
          expect(JSON.stringify(final.payload)).not.toContain(png);
          expect(JSON.stringify(final.payload)).not.toContain(middlePng);
        } finally {
          await loop.shutdown();
          await new Promise<void>((resolve, reject) =>
            provider.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
  },
);
