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
import { startJobLoop } from "./job-loop.js";
import { createJobService } from "./job-service.js";
import { createJobRepository } from "./repository.js";
import "./executors/image-generation.js";

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
    async function fixture(mode: "limited" | "auth" | "balance" | "lost") {
      const submittedAt: number[] = [];
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
          /* 消费模拟供应商输入 */
        }
        submittedAt.push(Date.now());
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
        protocol: "openai-compatible",
        baseUrl: `${baseUrl}/v1`,
        apiKey: "test-only",
        models: [
          { id: "gpt-image-1", name: "模拟图片模型", capability: "image" },
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
        jobType: "image_generation" as const,
        payload: {
          prompt: "猫",
          model: "gpt-image-1",
          provider_instance_id: provider.id,
        },
      };
      const job = await jobs.createJob(db.actor, input);
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
          },
        },
        { queues: ["image_generation_jobs"] },
      );
      return {
        jobs,
        job,
        input,
        submittedAt,
        async close() {
          await loop.shutdown();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        },
      };
    }
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
            (await f.jobs.getJob(db.actor, f.job.id)).error_message,
          ).toContain(mode === "auth" ? "模拟鉴权失败" : "模拟余额不足");
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
        expect(f.submittedAt).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
  },
);
