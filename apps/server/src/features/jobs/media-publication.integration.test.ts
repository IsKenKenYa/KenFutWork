import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
    it("持有执行租约的worker完成图片发布，Job与画布均保留唯一结果", async () => {
      const db = await createTaskWorkDatabase();
      const workerUrl = new URL(db.connectionString);
      // 回归失败时让锁内跨连接自等待及时退出，shutdown也必须能够完成。
      workerUrl.searchParams.set("options", "-c lock_timeout=750ms");
      const persistence = createPostgresPersistence({
        databaseUrl: workerUrl.toString(),
      });
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=";
      let submissions = 0;
      const provider = createServer(async (request, response) => {
        for await (const _chunk of request) {
          /* 消费可控供应商请求体。 */
        }
        submissions++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ b64_json: png }] }));
      });
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
          models: [{ id: "gpt-image-1", name: "图片模型", capability: "image" }],
        });
        const job = await jobs.createJob(db.actor, {
          requestId: randomUUID(),
          interactiveRequest: true,
          projectId,
          canvasId: document.id,
          jobType: "image_generation",
          payload: {
            prompt: "猫",
            model: "gpt-image-1",
            provider_instance_id: configured.id,
            generator_id: generatorId,
          },
        });
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
            },
          },
          { queues: ["image_generation_jobs"] },
        );
        stopWorker = () => loop.shutdown();
        await vi.waitFor(
          async () =>
            expect(await jobs.getJob(db.actor, job.id)).toMatchObject({
              status: "succeeded",
              result: { asset_id: job.id, element_id: expect.any(String) },
            }),
          { timeout: 5000 },
        );
        const completed = await jobs.getJob(db.actor, job.id);
        const published = await canvas.getCanvas(db.actor, document.id);
        const images = published.content.elements.filter(
          (element) => element.type === "image" && !element.isDeleted,
        );
        expect(submissions).toBe(1);
        expect(images).toHaveLength(1);
        expect(images[0]?.id).toBe(completed.result?.element_id);
        expect(Object.values(published.content.files)).toEqual([
          expect.objectContaining({ assetId: job.id, mimeType: "image/png" }),
        ]);
        expect(await projectFiles.read(db.actor, job.id)).toEqual(
          Buffer.from(png, "base64"),
        );
      } finally {
        await stopWorker();
        await new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        );
        await persistence.close();
        await db.close();
      }
    }, 30_000);
  },
);
