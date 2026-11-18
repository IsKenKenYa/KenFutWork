import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createCodeUiConversation } from "../code-ui/conversation.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createUploadRepository } from "../uploads/repository.js";
import { createProjectFileRepository } from "./repository.js";
import { createProjectFileService } from "./service.js";

describe.skipIf(process.env.KENFUTWORK_PROJECT_FILES_TEST_PG !== "1")(
  "ProjectFile真实持久索引 integration",
  () => {
    it("legacy Canvas素材同身份准备幂等，跨Canvas拒绝不破坏原pending绑定", async () => {
      const db = await createTaskWorkDatabase();
      try {
        const projects = createProjectRepository(db.persistence);
        const { project } = await projects.createProject({
          instanceId: db.instanceId,
          createdByClientId: db.actor.accessClientId,
          kind: "design",
          name: "Canvas素材",
          slug: randomUUID(),
          description: null,
          canvasName: "Canvas",
          workDir: db.context.scope.rootDirectory,
          directoryChoice: "independent",
        });
        const sql = db.persistence.forInstance(db.instanceId);
        const canvas = { id: randomUUID() };
        await sql.execute(
          "insert into public.canvases(id,project_id,name,is_primary,root_directory) select $1,p.id,'Canvas',true,p.work_dir from public.projects p where p.id=$2 and p.instance_id=:instance",
          [canvas.id, project.id],
        );
        const otherCanvasId = randomUUID();
        await sql.execute(
          "insert into public.canvases(id,project_id,name,is_primary,root_directory) select $1,p.id,'Other',false,p.work_dir from public.projects p where p.id=$2 and p.instance_id=:instance",
          [otherCanvasId, project.id],
        );
        const files = createProjectFileService({
          repository: createProjectFileRepository(db.persistence),
          localInstance: db.localInstance,
          canvases: createCanvasRepository(db.persistence),
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
        const bytes = Buffer.from("legacy-canvas-source");
        const legacy = await createUploadRepository(db.persistence).insert({
          instanceId: db.instanceId,
          createdByClientId: db.actor.accessClientId,
          bucket: "project-assets",
          objectPath: `${db.instanceId}/legacy/canvas.png`,
          mimeType: "image/png",
          byteSize: bytes.byteLength,
        });
        if (!legacy) throw new Error("真实旧Canvas素材未创建");
        const input = {
          target: {
            kind: "canvas" as const,
            projectId: project.id,
            canvasId: canvas.id,
          },
          assetId: legacy.id,
          relativePath: "legacy.png",
          mimeType: "image/png",
          writeFingerprint: createHash("sha256").update(bytes).digest("hex"),
        };
        const receipt = await files.prepareWrite(db.actor, input);
        const state = () =>
          sql.queryOne(
            "select canvas_id,task_id,task_kind,file_state,relative_path,legacy_bucket,legacy_object_path from public.asset_objects where instance_id=:instance and id=$1",
            [legacy.id],
          );
        const pending = await state();
        expect(pending).toMatchObject({
          canvas_id: canvas.id,
          task_id: null,
          task_kind: null,
          file_state: "pending",
          relative_path: "legacy.png",
          legacy_bucket: "project-assets",
          legacy_object_path: `${db.instanceId}/legacy/canvas.png`,
        });
        expect(await files.prepareWrite(db.actor, input)).toEqual(receipt);
        await expect(
          files.prepareWrite(db.actor, {
            ...input,
            target: { ...input.target, canvasId: otherCanvasId },
          }),
        ).rejects.toMatchObject({ code: "file_conflict" });
        expect(await state()).toEqual(pending);
        await files.namespaceProvider.upload(receipt.objectPath, bytes, {
          contentType: "image/png",
          upsert: true,
        });
        expect(await files.prepareWrite(db.actor, input)).toEqual(receipt);
        expect(await files.read(db.actor, legacy.id)).toEqual(bytes);
        await expect(
          files.read(db.actor, legacy.id, { maxBytes: bytes.byteLength - 1 }),
        ).rejects.toMatchObject({ statusCode: 413 });
        expect(
          await files.read(db.actor, legacy.id, { maxBytes: bytes.byteLength }),
        ).toEqual(bytes);
        expect((await state())?.file_state).toBe("ready");
        await expect(
          files.prepareWrite(db.actor, {
            ...input,
            target: { ...input.target, canvasId: otherCanvasId },
          }),
        ).rejects.toMatchObject({ code: "file_conflict" });
        expect((await state())?.canvas_id).toBe(canvas.id);
        expect(await files.read(db.actor, legacy.id)).toEqual(bytes);
      } finally {
        await db.close();
      }
    });
    it("10MiB原片不受文本补丁限制，旧Blob保留、Task发布幂等且真实代际拒绝迟到写", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const { actor, instanceId } = database;
        const scope = { ...database.context.scope, taskId: randomUUID() };
        // TaskWork数据库夹具的原行只用于后台工作；真实执行作用域必须有Code chat父链。
        await createCodeUiRepository(database.persistence).createRoot(
          instanceId,
          {
            sessionId: scope.taskId,
            projectId: scope.projectId,
            scope,
            createdByClientId: actor.accessClientId,
            threadId: randomUUID(),
            state: createCodeUiConversation({
              sessionId: scope.taskId,
              workspacePath: scope.rootDirectory,
              config: {
                provider: "fixture",
                model: "fixture",
                thought: "",
                followupMode: "queue",
              },
            }).exportState(),
            command: {
              clientId: "project-file-integration",
              commandId: randomUUID(),
              fingerprint: "controlled-task-create",
            },
          },
        );
        const projects = createProjectRepository(database.persistence);
        const service = createProjectFileService({
          repository: createProjectFileRepository(database.persistence),
          localInstance: database.localInstance,
          projects: {
            getProject: async (current, id) => {
              const row = await projects.findActiveById(current.instanceId, id);
              if (!row) throw new Error("项目不可用");
              return row;
            },
          },
          executionScopes: createExecutionScopes({
            repository: createScopeRepository(database.persistence),
            localInstance: database.localInstance,
          }),
        });
        const newDefault = join(database.directory, "project-new-default");
        await mkdir(newDefault);
        await database.persistence
          .forInstance(instanceId)
          .execute(
            "update public.projects set work_dir=$2 where instance_id=:instance and id=$1",
            [scope.projectId, newDefault],
          );
        const bytes = Buffer.alloc(10_519_749, 0x5a);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const legacyBlob = createLocalFsBlobStore({
          rootDir: join(database.directory, "legacy-blob"),
          publicBaseUrl: "http://localhost/api/blobs",
          signingSecret: "fixture-blob-signing-only",
        }).bucket("project-assets");
        const legacyPath = `${instanceId}/legacy/image.bin`;
        await legacyBlob.upload(legacyPath, bytes);
        const asset = await createUploadRepository(database.persistence).insert(
          {
            instanceId,
            projectId: scope.projectId,
            bucket: "project-assets",
            objectPath: legacyPath,
            byteSize: bytes.length,
            mimeType: "application/octet-stream",
          },
        );
        if (!asset) throw new Error("真实旧资产未创建");
        const input = {
          target: { kind: "task" as const, taskId: scope.taskId },
          assetId: asset.id,
          relativePath: "assets/source.bin",
          mimeType: "application/octet-stream",
          writeFingerprint: hash,
        };
        const receipt = await service.prepareWrite(actor, input);
        await service.namespaceProvider.upload(receipt.objectPath, bytes);
        await service.namespaceProvider.upload(receipt.objectPath, bytes);
        await expect(
          service.namespaceProvider.upload(
            receipt.objectPath,
            Buffer.alloc(bytes.byteLength, 0xa5),
          ),
        ).rejects.toMatchObject({ code: "file_conflict" });
        expect(
          createHash("sha256")
            .update(
              await readFile(join(scope.rootDirectory, input.relativePath)),
            )
            .digest("hex"),
        ).toBe(hash);
        await expect(
          readFile(join(newDefault, input.relativePath)),
        ).rejects.toThrow();
        expect(
          Buffer.from(await legacyBlob.download(legacyPath)).equals(bytes),
        ).toBe(true);
        const source = await database.persistence
          .forInstance(instanceId)
          .queryOne<{
            legacy_bucket: string;
            legacy_object_path: string;
            file_state: string;
          }>(
            "select legacy_bucket,legacy_object_path,file_state from public.asset_objects where instance_id=:instance and id=$1",
            [asset.id],
          );
        expect(source).toEqual({
          legacy_bucket: "project-assets",
          legacy_object_path: legacyPath,
          file_state: "ready",
        });
        expect(await service.prepareWrite(actor, input)).toEqual(receipt);
        const moved = await service.move(actor, asset.id, "assets/renamed.bin");
        expect(moved.objectPath).toBe(receipt.objectPath);
        expect(
          Buffer.from(await service.read(actor, asset.id)).equals(bytes),
        ).toBe(true);
        const delayed = await service.prepareWrite(actor, {
          ...input,
          assetId: randomUUID(),
          relativePath: "assets/late.bin",
        });
        await database.persistence
          .forInstance(instanceId)
          .execute(
            "update public.code_ui_sessions set scope_generation=scope_generation+1 where instance_id=:instance and id=$1",
            [scope.taskId],
          );
        await expect(
          service.namespaceProvider.upload(delayed.objectPath, bytes),
        ).rejects.toMatchObject({ code: "scope_changed" });
        await expect(
          service.read({ ...actor, instanceId: randomUUID() }, asset.id),
        ).rejects.toThrow();
      } finally {
        await database.close();
      }
    });
  },
);
