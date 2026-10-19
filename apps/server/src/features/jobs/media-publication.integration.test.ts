import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { generationSubmissionSchema } from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerGenerateRoutes } from "../../http/generate.js";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import { createCanvasService } from "../canvas/canvas-service.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGenerationTargets } from "../generation/file-targets.js";
import { createModelProviderService } from "../model-providers/model-provider-service.js";
import { createModelProviderRepository } from "../model-providers/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createProjectFileRepository } from "../project-files/repository.js";
import { createProjectFileService } from "../project-files/service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createInProcessQueue } from "../queue/providers/in-process.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createAssetWriter } from "../uploads/asset-writer.js";
import { createUploadRepository } from "../uploads/repository.js";
import { startJobLoop } from "./job-loop.js";
import { createJobService } from "./job-service.js";
import { createJobRepository } from "./repository.js";
import "./executors/image-generation.js";

describe.skipIf(process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1")(
  "媒体Job真实画布发布",
  () => {
    it("HTTP多图拆分乱序完成后按请求顺序独立排布，重放请求不重复生成或发布", async () => {
      const db = await createTaskWorkDatabase();
      const workerUrl = new URL(db.connectionString);
      // 回归失败时让锁内跨连接自等待及时退出，shutdown也必须能够完成。
      workerUrl.searchParams.set("options", "-c lock_timeout=750ms");
      const persistence = createPostgresPersistence({
        databaseUrl: workerUrl.toString(),
      });
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=";
      const submissions: number[] = [];
      let releaseFirst = () => {};
      const firstResponse = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const provider = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          n: number;
        };
        const index = submissions.length;
        submissions.push(body.n);
        if (index === 0) await firstResponse;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: Array.from({ length: body.n }, () => ({ b64_json: png })),
          }),
        );
      });
      const app = Fastify();
      let stopWorker = async () => {};
      try {
        await new Promise<void>((resolve) =>
          provider.listen(0, "127.0.0.1", resolve),
        );
        const address = provider.address();
        if (!address || typeof address === "string")
          throw new Error("模拟供应商未启动");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const projectId = db.context.scope.projectId;
        await persistence
          .forInstance(db.instanceId)
          .execute(
            `update public.projects set enabled_modes=array['code','design']::text[] where id=$1 and instance_id=:instance`,
            [projectId],
          );
        const projects = createProjectRepository(persistence);
        const projectAccess = {
          getProject: async (actor: typeof db.actor, id: string) => {
            const project = await projects.findActiveById(actor.instanceId, id);
            if (!project) throw new Error("项目不存在");
            return project;
          },
        };
        const executionScopes = createExecutionScopes({
          repository: createScopeRepository(persistence),
          localInstance: db.localInstance,
        });
        const canvasRepository = createCanvasRepository(persistence);
        const projectFiles = createProjectFileService({
          repository: createProjectFileRepository(persistence),
          localInstance: db.localInstance,
          projects: projectAccess,
          executionScopes,
          canvases: canvasRepository,
        });
        const blob = createLocalFsBlobStore({
          rootDir: join(db.directory, "publication-blobs"),
          signingSecret: "test-only",
          publicBaseUrl: baseUrl,
        });
        blob.registerNamespace({
          bucket: "project-assets",
          namespace: "project-files",
          provider: projectFiles.namespaceProvider,
          publicRead: false,
        });
        const canvas = createCanvasService({
          repository: canvasRepository,
          localInstance: db.localInstance,
          projects: projectAccess,
          projectFiles,
          blob,
        });
        const insertImageElement = canvas.insertImageElement;
        const publicationReceipts: string[] = [];
        let lostReceiptElementId: string | undefined;
        canvas.insertImageElement = async (actor, request, beforePublish) => {
          const receipt = await insertImageElement(
            actor,
            request,
            beforePublish,
          );
          publicationReceipts.push(receipt.elementId);
          if (lostReceiptElementId === undefined) {
            lostReceiptElementId = receipt.elementId;
            // 模拟画布已提交，但worker尚未保存published检查点时丢失回执。
            throw Object.assign(new Error("画布发布回执暂时丢失"), {
              status: 503,
              retryAfter: "0",
            });
          }
          return receipt;
        };
        const document = await canvas.createCanvas(db.actor, projectId, {
          name: "后台生成发布",
        });
        const generatorId = "image-generator";
        await canvas.saveCanvasContent(
          db.actor,
          document.id,
          {
            elements: [
              {
                id: generatorId,
                type: "rectangle",
                x: 0,
                y: 0,
                width: 200,
                height: 200,
                isDeleted: false,
                customData: { type: "image-generator", status: "idle" },
              },
            ],
            appState: {},
            files: {},
          },
          document.revision,
        );
        const generationTargets = createGenerationTargets({
          persistence,
          executionScopes,
        });
        const queue = createInProcessQueue();
        const jobs = createJobService({
          repository: createJobRepository(persistence),
          localInstance: db.localInstance,
          generationTargets,
          queue,
        });
        const modelProviders = createModelProviderService({
          repository: createModelProviderRepository(persistence),
          localInstance: db.localInstance,
        });
        const configured = await modelProviders.createInstance(db.actor, {
          name: "真实画布发布模拟供应商",
          apiKey: "test-only",
          baseUrl: `${baseUrl}/v1`,
          protocol: "openai-compatible",
          models: [
            {
              id: "gpt-image-1",
              name: "图片模型",
              capability: "image",
              imageGeneration: { maxOutputs: 2 },
            },
          ],
        });
        await registerGenerateRoutes(app, {
          localAccess: db.localAccess,
          localInstance: db.localInstance,
          jobService: jobs,
          modelProviders,
        });
        const payload = {
          requestId: randomUUID(),
          projectId,
          canvasId: document.id,
          prompt: "猫",
          model: "gpt-image-1",
          providerInstanceId: configured.id,
          generatorId,
          count: 5,
          placement: { x: 10, y: 20, width: 200, height: 200 },
        };
        const accepted = await app.inject({
          method: "POST",
          url: "/api/agent/generate-image",
          headers: { authorization: `Bearer ${db.desktopToken}` },
          payload,
        });
        expect(accepted.statusCode).toBe(202);
        const submission = generationSubmissionSchema.parse(accepted.json());
        expect(submission.jobs).toHaveLength(3);
        const loop = startJobLoop(
          {
            queue,
            jobService: jobs,
            generationTargets,
            modelProviders,
            projectFiles,
            canvas,
            blob,
            assetWriter: createAssetWriter(createUploadRepository(persistence)),
            env: {
              agentBackendMode: "state",
              agentModel: "test",
              port: 0,
              version: "test",
              webOrigin: baseUrl,
              workerPollIntervalMs: 1000,
              workerMaxBatchSize: 3,
            },
          },
          { queues: ["image_generation_jobs"] },
        );
        stopWorker = () => loop.shutdown();
        await vi.waitFor(
          async () => {
            const completed = await Promise.all(
              submission.jobs.map(({ job_id }) =>
                jobs.getJob(db.actor, job_id),
              ),
            );
            expect(
              completed.filter((job) => job.status === "succeeded"),
            ).toHaveLength(2);
          },
          { timeout: 5000 },
        );
        releaseFirst();
        await vi.waitFor(
          async () => {
            const completed = await Promise.all(
              submission.jobs.map(({ job_id }) =>
                jobs.getJob(db.actor, job_id),
              ),
            );
            expect(completed.map((job) => job.status)).toEqual([
              "succeeded",
              "succeeded",
              "succeeded",
            ]);
          },
          { timeout: 5000 },
        );
        const completed = await Promise.all(
          submission.jobs.map(({ job_id }) => jobs.getJob(db.actor, job_id)),
        );
        for (const job of completed)
          expect(job.result).toMatchObject({
            asset_id: job.id,
            element_id: job.result?.outputs?.[0]?.element_id,
          });
        const outputs = completed.flatMap((job) => job.result?.outputs ?? []);
        const published = await canvas.getCanvas(db.actor, document.id);
        const images = published.content.elements.filter(
          (element) => element.type === "image" && !element.isDeleted,
        );
        expect([...submissions].sort()).toEqual([1, 2, 2]);
        expect(outputs).toHaveLength(5);
        expect(new Set(outputs.map((output) => output.asset_id)).size).toBe(5);
        expect(images).toHaveLength(5);
        expect(new Set(images.map((image) => image.id)).size).toBe(5);
        expect(publicationReceipts).toHaveLength(6);
        expect(new Set(publicationReceipts).size).toBe(5);
        expect(
          publicationReceipts.filter((id) => id === lostReceiptElementId),
        ).toHaveLength(2);
        expect(images.map((image) => image.id).sort()).toEqual(
          outputs.map((output) => output.element_id).sort(),
        );
        expect(
          outputs.map((output) => {
            const image = images.find(({ id }) => id === output.element_id);
            return image
              ? {
                  x: image.x,
                  y: image.y,
                  width: image.width,
                  height: image.height,
                }
              : undefined;
          }),
        ).toEqual([
          { x: 10, y: 20, width: 200, height: 200 },
          { x: 210, y: 20, width: 200, height: 200 },
          { x: 410, y: 20, width: 200, height: 200 },
          { x: 610, y: 20, width: 200, height: 200 },
          { x: 810, y: 20, width: 200, height: 200 },
        ]);
        expect(Object.values(published.content.files)).toHaveLength(5);
        expect(new Set(images.map((image) => image.fileId)).size).toBe(5);
        expect(
          Object.values(published.content.files)
            .map((file) => file.assetId)
            .sort(),
        ).toEqual(outputs.map((output) => output.asset_id).sort());
        expect(Object.values(published.content.files)).toEqual(
          expect.arrayContaining(
            outputs.map((output) =>
              expect.objectContaining({
                assetId: output.asset_id,
                mimeType: "image/png",
              }),
            ),
          ),
        );
        for (const output of outputs)
          expect(await projectFiles.read(db.actor, output.asset_id)).toEqual(
            Buffer.from(png, "base64"),
          );
        await modelProviders.updateInstance(db.actor, configured.id, {
          expectedRevision: configured.configRevision,
          models: configured.models.map((model) => ({
            ...model,
            imageGeneration: { maxOutputs: 1 },
          })),
        });
        const replay = await app.inject({
          method: "POST",
          url: "/api/agent/generate-image",
          headers: { authorization: `Bearer ${db.desktopToken}` },
          payload,
        });
        expect(replay.statusCode).toBe(202);
        expect(generationSubmissionSchema.parse(replay.json()).jobs).toEqual(
          submission.jobs.map(({ job_id }) => ({
            job_id,
            status: "succeeded",
          })),
        );
        expect(
          await jobs.listJobs(db.actor, { requestId: payload.requestId }),
        ).toHaveLength(3);
        expect((await canvas.getCanvas(db.actor, document.id)).content).toEqual(
          published.content,
        );
        expect([...submissions].sort()).toEqual([1, 2, 2]);
        expect(publicationReceipts).toHaveLength(6);
      } finally {
        releaseFirst();
        await stopWorker();
        await app.close();
        await new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        );
        await persistence.close();
        await db.close();
      }
    }, 30_000);
  },
);
