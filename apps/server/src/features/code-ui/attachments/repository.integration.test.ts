import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceSettingsSchema } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createLocalFsBlobStore } from "../../blob/providers/local-fs.js";
import type { PersistenceSessionLock } from "../../persistence/types.js";
import { createTaskWorkDatabase } from "../../task-work/test-postgres-schema.js";
import { codeAttachmentLimits } from "./budget.js";
import { createCodeAttachmentRepository } from "./repository.js";
import { createCodeAttachmentsService } from "./service.js";
import type { CodeAttachmentSession, CodeAttachmentsDeps } from "./types.js";

/** Disposable localhost cluster only; never reads DATABASE_URL. */
describe.skipIf(process.env.KENFUTWORK_ATTACHMENT_TEST_PG !== "1")(
  "Code 附件真实持久事务 integration",
  () => {
    it("全迁移重放/noop、同键并发重放、重启中断staging、归档预览与迟到commit代际护栏", async () => {
      const database = await createTaskWorkDatabase();
      const directory = await mkdtemp(join(tmpdir(), "kfw-attachment-pg-"));
      const repositories: ReturnType<typeof createCodeAttachmentRepository>[] =
        [];
      const services: ReturnType<typeof createCodeAttachmentsService>[] = [];
      try {
        expect(database.replayed).toHaveLength(database.expectedMigrations);
        expect(database.secondReplay).toHaveLength(0);
        const instanceId = database.context.scope.instanceId;

        const actor = {
          instanceId: database.context.scope.instanceId,
          accessClientId: null,
        };
        const identity: CodeAttachmentSession = {
          instanceId,
          projectId: database.context.scope.projectId,
          taskId: database.context.scope.taskId,
          sessionId: database.context.scope.taskId,
          createdByClientId: actor.accessClientId,
          scopeGeneration: database.context.scope.generation,
          branchGeneration: database.context.branchGeneration,
          revision: 0,
          canUpload: true,
        };
        const settings = instanceSettingsSchema.parse({
          defaultModel: "fixture",
        });
        const bytes = Buffer.from([0, 255, 2, 3]);
        const plan = {
          sessionId: identity.sessionId,
          fileName: "private.bin",
          mime: "application/octet-stream",
          totalBytes: bytes.length,
          checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
        let ref = "";
        const create = () => {
          const repository = createCodeAttachmentRepository(
            database.persistence,
            "attachment-private-host",
          );
          repositories.push(repository);
          const deps: CodeAttachmentsDeps = {
            repository,
            blob: createLocalFsBlobStore({
              rootDir: directory,
              publicBaseUrl: "http://localhost/blobs",
              signingSecret: "private-attachment-test",
            }),
            async authorizeSession(_actor, sessionId) {
              return { ...identity, taskId: sessionId, sessionId };
            },
            async authorizeRow(_actor, input) {
              if (
                input.sessionId !== identity.sessionId ||
                input.target?.rowId !== 2 ||
                input.target.entityId !== "input-a" ||
                input.attachmentIndex !== 0 ||
                input.ref !== ref
              )
                throw new Error("附件不属于消息行。");
              return {
                ref,
                fileName: plan.fileName,
                mime: plan.mime,
                bytes: bytes.length,
              };
            },
            async limits() {
              return codeAttachmentLimits(settings);
            },
          };
          const service = createCodeAttachmentsService(deps);
          services.push(service);
          return { repository, service };
        };
        const initial = create();
        await initial.service.initialize();
        const upload = {
          sessionId: identity.sessionId,
          connectionId: "owned-connection",
          uploadId: "upload-a",
        };
        await initial.service.begin(actor, { ...plan, ...upload });
        await initial.service.chunk(actor, {
          ...upload,
          chunkIndex: 0,
          dataBase64: bytes.toString("base64"),
        });
        const results = await Promise.all([
          initial.service.commit(actor, upload),
          initial.service.commit(actor, upload),
        ]);
        expect(results[0]).toEqual(results[1]);
        const first = results[0];
        if (!first) throw new Error("附件提交缺少持久引用。");
        ref = first.ref;
        const interrupted = { ...upload, uploadId: "lost-staging" };
        await initial.service.begin(actor, { ...plan, ...interrupted });
        // Simulated process loss releases the DB host lease without graceful connection abort.
        await initial.repository.close();
        const restarted = create();
        await restarted.service.initialize();
        await expect(
          restarted.service.commit(actor, interrupted),
        ).rejects.toMatchObject({ code: "fault.attachment.interrupted" });
        await expect(
          restarted.service.begin(actor, { ...plan, ...upload }),
        ).resolves.toMatchObject({ state: "committed", ref });
        await database.persistence
          .forInstance(instanceId)
          .execute(
            "update public.code_ui_sessions set archived = true where instance_id = :instance and id = $1",
            [identity.taskId],
          );
        const read = {
          sessionId: identity.sessionId,
          ref,
          target: { rowId: 2, entityId: "input-a" },
          attachmentIndex: 0,
          offset: 0,
          limit: bytes.length,
        };
        expect(
          (await restarted.service.read(actor, read, "share")).dataBase64,
        ).toBe(bytes.toString("base64"));
        await database.persistence
          .forInstance(instanceId)
          .execute(
            "update public.code_ui_sessions set archived = false where instance_id = :instance and id = $1",
            [identity.taskId],
          );
        const late = { ...upload, uploadId: "late-generation" };
        await restarted.service.begin(actor, { ...plan, ...late });
        await restarted.service.chunk(actor, {
          ...late,
          chunkIndex: 0,
          dataBase64: bytes.toString("base64"),
        });
        await database.persistence
          .forInstance(instanceId)
          .execute(
            "update public.code_ui_sessions set scope_generation = scope_generation + 1, branch_generation = branch_generation + 1 where instance_id = :instance and id = $1",
            [identity.taskId],
          );
        await expect(
          restarted.service.commit(actor, late),
        ).rejects.toMatchObject({ code: "fault.attachment.staleTask" });
        const rows = await database.persistence
          .forInstance(instanceId)
          .query<{ status: string; record: Record<string, unknown> }>(
            "select status, record from public.code_attachments where instance_id = :instance and task_id = $1",
            [identity.taskId],
          );
        expect(rows.filter((row) => row.status === "committed")).toHaveLength(
          1,
        );
        expect(rows.filter((row) => row.status === "aborted")).toHaveLength(2);
        for (const row of rows.filter((item) => item.status === "aborted"))
          expect(Object.keys(row.record).sort()).toEqual([
            "createdByClientId",
            "instanceId",
            "key",
            "projectId",
            "sessionId",
            "status",
            "taskId",
          ]);
      } finally {
        await Promise.allSettled(services.map((service) => service.close()));
        await Promise.all(repositories.map((repository) => repository.close()));
        await database.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
    it("Blob 已写入但宿主租约在回执前失效时，旧实例只能留中断墓碑并清自己的私有 bytes", async () => {
      const database = await createTaskWorkDatabase();
      const directory = await mkdtemp(join(tmpdir(), "kfw-attachment-lease-"));
      let lease: PersistenceSessionLock | null = null;
      const repository = createCodeAttachmentRepository(
        {
          ...database.persistence,
          async acquireSessionLock(key) {
            lease = await database.persistence.acquireSessionLock(key);
            return lease;
          },
        },
        "attachment-lease-host",
      );
      const localBlob = createLocalFsBlobStore({
        rootDir: directory,
        publicBaseUrl: "http://localhost/blobs",
        signingSecret: "private-attachment-lease",
      });
      let writtenPath = "";
      let service: ReturnType<typeof createCodeAttachmentsService> | undefined;
      try {
        const scope = database.context.scope;

        const actor = {
          instanceId: database.context.scope.instanceId,
          accessClientId: null,
        };
        const identity: CodeAttachmentSession = {
          instanceId: scope.instanceId,
          projectId: scope.projectId,
          taskId: scope.taskId,
          sessionId: scope.taskId,
          createdByClientId: actor.accessClientId,
          scopeGeneration: scope.generation,
          branchGeneration: database.context.branchGeneration,
          revision: 0,
          canUpload: true,
        };
        const settings = instanceSettingsSchema.parse({
          defaultModel: "fixture",
        });
        service = createCodeAttachmentsService({
          repository,
          blob: {
            bucket(name) {
              const bucket = localBlob.bucket(name);
              return {
                ...bucket,
                async upload(path, bytes, options) {
                  await bucket.upload(path, bytes, options);
                  writtenPath = path;
                  const active = lease;
                  if (!active) throw new Error("附件宿主未获得真实租约。");
                  // Public native lease API invalidates ownership while upload's promise is still pending.
                  await active.release();
                },
              };
            },
          },
          async authorizeSession() {
            return identity;
          },
          async authorizeRow() {
            throw new Error("此租约回归不读取消息预览。");
          },
          async limits() {
            return codeAttachmentLimits(settings);
          },
        });
        await service.initialize();
        const bytes = Buffer.from([0, 255, 1, 2]);
        const upload = {
          sessionId: scope.taskId,
          connectionId: "lease-connection",
          uploadId: "lease-upload",
        };
        await service.begin(actor, {
          ...upload,
          fileName: "lease.bin",
          mime: "application/octet-stream",
          totalBytes: bytes.length,
          checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        });
        await service.chunk(actor, {
          ...upload,
          chunkIndex: 0,
          dataBase64: bytes.toString("base64"),
        });
        await expect(service.commit(actor, upload)).rejects.toMatchObject({
          code: "fault.attachment.hostUnavailable",
        });
        const rows = await database.persistence
          .forInstance(scope.instanceId)
          .query<{ status: string; record: Record<string, unknown> }>(
            "select status, record from public.code_attachments where instance_id = :instance and task_id = $1",
            [scope.taskId],
          );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("aborted");
        expect(rows[0]?.record).not.toHaveProperty("ref");
        expect(rows[0]?.record).not.toHaveProperty("checksum");
        await expect(
          localBlob.bucket("code-attachments").download(writtenPath),
        ).rejects.toThrow();
      } finally {
        await service?.close();
        await repository.close();
        await database.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
    it("Task释放保留已提交消息，删除只在revoking精确代际清私有对象且留下最小墓碑", async () => {
      const database = await createTaskWorkDatabase();
      const directory = await mkdtemp(
        join(tmpdir(), "kfw-attachment-lifecycle-"),
      );
      const repository = createCodeAttachmentRepository(
        database.persistence,
        "attachment-lifecycle-host",
      );
      const blob = createLocalFsBlobStore({
        rootDir: directory,
        publicBaseUrl: "http://localhost/blobs",
        signingSecret: "private-lifecycle-test",
      });
      let service: ReturnType<typeof createCodeAttachmentsService> | undefined;
      try {
        const scope = database.context.scope;

        const actor = {
          instanceId: database.context.scope.instanceId,
          accessClientId: null,
        };
        let generation = scope.generation;
        const settings = instanceSettingsSchema.parse({
          defaultModel: "fixture",
        });
        const bytes = Buffer.from([0, 255, 3, 4]);
        let ref = "";
        service = createCodeAttachmentsService({
          repository,
          blob,
          async authorizeSession() {
            return {
              instanceId: scope.instanceId,
              projectId: scope.projectId,
              taskId: scope.taskId,
              sessionId: scope.taskId,
              createdByClientId: actor.accessClientId,
              scopeGeneration: generation,
              branchGeneration: database.context.branchGeneration,
              revision: 0,
              canUpload: true,
            };
          },
          async authorizeRow(_actor, request) {
            if (
              request.ref !== ref ||
              request.target?.entityId !== "lifecycle-input" ||
              request.attachmentIndex !== 0
            )
              throw new Error("消息位置不匹配。");
            return {
              ref,
              fileName: "own.bin",
              mime: "application/octet-stream",
              bytes: bytes.length,
            };
          },
          async limits() {
            return codeAttachmentLimits(settings);
          },
        });
        await service.initialize();
        const plan = {
          fileName: "own.bin",
          mime: "application/octet-stream",
          totalBytes: bytes.length,
          checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
        const upload = {
          sessionId: scope.taskId,
          connectionId: "lifecycle-connection",
          uploadId: "committed",
        };
        await service.begin(actor, { ...upload, ...plan });
        await service.chunk(actor, {
          ...upload,
          chunkIndex: 0,
          dataBase64: bytes.toString("base64"),
        });
        ref = (await service.commit(actor, upload)).ref;
        const staged = { ...upload, uploadId: "unfinished" };
        await service.begin(actor, { ...staged, ...plan });
        await service.releaseTask(scope.instanceId, scope.taskId);
        await expect(service.commit(actor, staged)).rejects.toMatchObject({
          code: "fault.attachment.interrupted",
        });
        const read = {
          sessionId: scope.taskId,
          ref,
          target: { rowId: 2, entityId: "lifecycle-input" },
          attachmentIndex: 0,
          offset: 0,
          limit: bytes.length,
        };
        expect((await service.read(actor, read, "share")).dataBase64).toBe(
          bytes.toString("base64"),
        );
        await expect(
          service.purgeTask(actor, scope.taskId, generation),
        ).rejects.toMatchObject({ code: "fault.attachment.staleTask" });
        const row = await database.persistence
          .forInstance(scope.instanceId)
          .queryOne<{ record: { objectPath: string } }>(
            "select record from public.code_attachments where instance_id = :instance and task_id = $1 and status = 'committed'",
            [scope.taskId],
          );
        if (!row) throw new Error("已提交附件丢失。");
        await blob
          .bucket("code-attachments")
          .upload("unrelated/keep", Buffer.from([9]));
        generation += 1;
        await database.persistence
          .forInstance(scope.instanceId)
          .execute(
            "update public.code_ui_sessions set scope_generation = $2, execution_state = 'revoking' where instance_id = :instance and id = $1",
            [scope.taskId, generation],
          );
        await expect(
          service.purgeTask(actor, scope.taskId, generation - 1),
        ).rejects.toMatchObject({ code: "fault.attachment.staleTask" });
        await service.purgeTask(actor, scope.taskId, generation);
        await expect(
          blob.bucket("code-attachments").download(row.record.objectPath),
        ).rejects.toThrow();
        expect(
          Array.from(
            await blob.bucket("code-attachments").download("unrelated/keep"),
          ),
        ).toEqual([9]);
        const rows = await database.persistence
          .forInstance(scope.instanceId)
          .query<{ status: string; record: Record<string, unknown> }>(
            "select status, record from public.code_attachments where instance_id = :instance and task_id = $1",
            [scope.taskId],
          );
        expect(rows).toHaveLength(2);
        for (const item of rows) {
          expect(item.status).toBe("aborted");
          expect(Object.keys(item.record).sort()).toEqual([
            "createdByClientId",
            "instanceId",
            "key",
            "projectId",
            "sessionId",
            "status",
            "taskId",
          ]);
        }
        await expect(service.commit(actor, upload)).rejects.toMatchObject({
          code: "fault.attachment.interrupted",
        });
      } finally {
        await service?.close();
        await repository.close();
        await database.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);
