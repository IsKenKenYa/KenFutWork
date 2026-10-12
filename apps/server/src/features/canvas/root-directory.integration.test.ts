import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerBlobRoutes } from "../../http/blobs.js";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import { createChatRepository } from "../chat/repository.js";
import { createDesignTasksService } from "../execution/design-tasks.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createProjectFileRepository } from "../project-files/repository.js";
import { createProjectFileService } from "../project-files/service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCanvasRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_DESIGN_TASK_TEST_PG !== "1")(
  "Canvas固定目录真实归属",
  () => {
    it("Project稳定目录：Canvas与新Task同根，旧分流目录明确冲突，素材读写保持同根", async () => {
      const db = await createTaskWorkDatabase();
      const app = Fastify();
      const tasks = createDesignTasksService({
        persistence: db.persistence,
        localInstance: db.localInstance,
      });
      try {
        const oldRoot = join(db.directory, "old-canvas"),
          newRoot = join(db.directory, "new-canvas");
        await mkdir(oldRoot);
        await mkdir(newRoot);
        const projects = createProjectRepository(db.persistence);
        const { project, canvas } = await projects.createProject({
          instanceId: db.instanceId,
          createdByClientId: db.actor.accessClientId,
          kind: "design",
          name: "固定画布",
          slug: randomUUID(),
          description: null,
          canvasName: "旧画布",
          workDir: oldRoot,
        });
        if (!canvas) throw new Error("Canvas缺失");
        const sql = db.persistence.forInstance(db.instanceId);
        // Corrupted or historical divergent Project paths are rejected, not adopted.
        await sql.execute(
          "update public.projects set work_dir=$2 where instance_id=:instance and id=$1",
          [project.id, newRoot],
        );
        const canvases = createCanvasRepository(db.persistence);
        await expect(
          canvases.claimRoot(
            db.instanceId,
            canvas.id,
            async (workDir) => workDir!,
          ),
        ).rejects.toThrow("目录不一致");
        expect(
          (await canvases.findById(db.instanceId, canvas.id))?.root_directory,
        ).toBe(oldRoot);
        await sql.execute(
          "update public.projects set work_dir=$2 where instance_id=:instance and id=$1",
          [project.id, oldRoot],
        );
        expect(
          await canvases.claimRoot(
            db.instanceId,
            canvas.id,
            async (workDir) => workDir!,
          ),
        ).toBe(oldRoot);
        const chat = createChatRepository(db.persistence);
        for (let index = 0; index < 2; index++) {
          const prepared = await tasks.prepareCreation(db.actor, canvas.id);
          if (!prepared) throw new Error("Task准备缺失");
          expect(prepared.rootDirectory).toBe(oldRoot);
          const session = await chat.createSession(db.instanceId, {
            canvasId: canvas.id,
            threadId: randomUUID(),
            createdByClientId: db.actor.accessClientId,
            designTaskPreparation: prepared,
          });
          if (!session) throw new Error("Task缺失");
          expect(
            (await tasks.readPolicy(db.actor, session.id)).rootDirectory,
          ).toBe(oldRoot);
        }
        const newCanvasId = randomUUID();
        await sql.execute(
          "insert into public.canvases(id,project_id,name,is_primary) select $1,p.id,'新画布',false from public.projects p where p.id=$2 and p.instance_id=:instance and p.archived_at is null",
          [newCanvasId, project.id],
        );
        expect(
          await canvases.claimRoot(
            db.instanceId,
            newCanvasId,
            async (workDir) => workDir!,
          ),
        ).toBe(oldRoot);
        const files = createProjectFileService({
          repository: createProjectFileRepository(db.persistence),
          localInstance: db.localInstance,
          canvases,
          projects: {
            getProject: async (actor, id) => {
              const row = await projects.findActiveById(actor.instanceId, id);
              if (!row) throw new Error("项目缺失");
              return row;
            },
          },
          executionScopes: createExecutionScopes({
            repository: createScopeRepository(db.persistence),
            localInstance: db.localInstance,
          }),
        });
        const bytes = Buffer.from("actual-canvas-bytes");
        const rootDir = join(db.directory, "blob");
        const signingSecret = "actual-canvas-test-signature";
        const blob = createLocalFsBlobStore({
          rootDir,
          signingSecret,
          publicBaseUrl: "http://localhost/api/blobs",
        });
        blob.registerNamespace({
          bucket: "project-assets",
          namespace: "project-files",
          provider: files.namespaceProvider,
          publicRead: false,
        });
        await registerBlobRoutes(app, { rootDir, signingSecret, blob });
        const latestDefault = join(db.directory, "latest-project-default");
        await mkdir(latestDefault);
        const published: { assetId: string; url: string; version: string }[] =
          [];
        for (const [canvasId, root] of [
          [canvas.id, oldRoot],
          [newCanvasId, oldRoot],
        ] as const) {
          const assetId = randomUUID();
          await files.prepareWrite(db.actor, {
            target: { kind: "canvas", projectId: project.id, canvasId },
            assetId,
            relativePath: "image.png",
            mimeType: "image/png",
            writeFingerprint: createHash("sha256").update(bytes).digest("hex"),
          });
          await files.namespaceProvider.upload(
            `${db.instanceId}/project-files/${assetId}`,
            bytes,
            { contentType: "image/png", upsert: true },
          );
          expect(await readFile(join(root, "image.png"))).toEqual(bytes);
          expect(await files.read(db.actor, assetId)).toEqual(bytes);
          expect((await files.inspect(db.actor, assetId)).canvasId).toBe(
            canvasId,
          );
          const objectPath = `${db.instanceId}/project-files/${assetId}`;
          const signed = new URL(
            await blob
              .bucket("project-assets")
              .createSignedUrl(objectPath, 3600),
          );
          const url = `${signed.pathname}${signed.search}`;
          published.push({
            assetId,
            url,
            version: createHash("sha256").update(bytes).digest("hex"),
          });
          // Stable asset identity survives moves inside the one Project directory.
          expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(
            bytes,
          );
          expect(
            (await app.inject({ method: "GET", url: signed.pathname }))
              .statusCode,
          ).toBe(403);
          const location = await files.inspect(db.actor, assetId);
          const moved = await files.move(db.actor, assetId, "moved.png", {
            expectedRelativePath: location.relativePath,
            expectedVersion: location.version,
          });
          expect(await readFile(join(root, "moved.png"))).toEqual(bytes);
          await expect(
            readFile(join(latestDefault, "moved.png")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(
            bytes,
          );
          await rename(join(root, "moved.png"), join(root, "chosen.png"));
          await files.relink(db.actor, assetId, {
            relativePath: "chosen.png",
            fileVersion: location.version,
            expectedRelativePath: moved.relativePath,
            expectedVersion: location.version,
          });
          expect(await files.read(db.actor, assetId)).toEqual(bytes);
          expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(
            bytes,
          );
          await expect(
            files.relink(db.actor, assetId, {
              relativePath: "../outside.png",
              fileVersion: location.version,
              expectedRelativePath: "chosen.png",
              expectedVersion: location.version,
            }),
          ).rejects.toMatchObject({ code: "invalid_path" });
          expect((await files.inspect(db.actor, assetId)).relativePath).toBe(
            "chosen.png",
          );
        }
        const wrong = await projects.createProject({
          instanceId: db.instanceId,
          createdByClientId: db.actor.accessClientId,
          kind: "design",
          name: "其他项目",
          slug: randomUUID(),
          description: null,
          canvasName: "画布",
          workDir: newRoot,
        });
        await expect(
          files.prepareWrite(db.actor, {
            target: {
              kind: "canvas",
              projectId: wrong.project.id,
              canvasId: canvas.id,
            },
            assetId: randomUUID(),
            relativePath: "wrong.png",
            mimeType: "image/png",
            writeFingerprint: createHash("sha256").update(bytes).digest("hex"),
          }),
        ).rejects.toMatchObject({ code: "scope_changed" });
        await sql.execute(
          "update public.projects set archived_at=now() where instance_id=:instance and id=$1",
          [project.id],
        );
        for (const asset of published) {
          expect(
            (await app.inject({ method: "GET", url: asset.url })).statusCode,
          ).toBe(404);
          await expect(
            files.read(db.actor, asset.assetId),
          ).rejects.toMatchObject({ code: "not_found" });
          await expect(
            files.move(db.actor, asset.assetId, "late.png", {
              expectedRelativePath: "chosen.png",
              expectedVersion: asset.version,
            }),
          ).rejects.toMatchObject({ code: "not_found" });
        }
      } finally {
        await app.close();
        await tasks.close();
        await db.close();
      }
    }, 60000);
  },
);
