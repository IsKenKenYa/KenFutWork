import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSettingsSchema } from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import type { AuthenticatedUser } from "../../auth/types.js";
import { createLocalFsBlobStore } from "../../blob/providers/local-fs.js";
import { codeAttachmentLimits } from "./budget.js";
import { createCodeAttachmentsService } from "./service.js";
import type {
  CodeAttachmentRecord,
  CodeAttachmentRepository,
  CodeAttachmentSession,
  CodeAttachmentsDeps,
  CodeAttachmentTransaction,
} from "./types.js";
import { CodeAttachmentError } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("无session预算只读工作区metadata，有session必须owned且缺提供方fail loud", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "kfw-code-attachment-budget-"),
  );
  directories.push(directory);
  const settings = workspaceSettingsSchema.parse({
    defaultModel: "fixture",
    codeAttachmentMaxPerInput: 1,
  });
  let writes = 0;
  let initializations = 0;
  const stored = repositoryFixture();
  const deps: CodeAttachmentsDeps = {
    blob: createLocalFsBlobStore({
      rootDir: directory,
      publicBaseUrl: "http://localhost/blobs",
      signingSecret: "budget-test",
    }),
    repository: {
      ...stored,
      async interruptStaging() { initializations += 1; },
      async transact<T>(
        session: CodeAttachmentSession,
        key: string,
        operation: (transaction: CodeAttachmentTransaction) => Promise<T>,
      ) {
        writes += 1;
        return stored.transact<T>(session, key, operation);
      },
    },
    async authorizeWorkspace() {
      return identity.workspaceId;
    },
    async authorizeSession(_actor, sessionId) {
      if (sessionId !== identity.sessionId)
        throw new CodeAttachmentError("notAuthorized", "非所属Task", 404);
      return identity;
    },
    async authorizeRow() {
      throw new Error("预算查询不读取消息。");
    },
    async limits() {
      return codeAttachmentLimits(settings);
    },
  };
  const service = createCodeAttachmentsService(deps);
  expect((await service.budget(actor)).maxPerInput).toBe(1);
  expect((await service.budget(actor, identity.sessionId)).maxBytes).toBe(
    settings.codeAttachmentMaxBytes,
  );
  await expect(service.budget(actor, "other-task")).rejects.toThrow(
    "非所属Task",
  );
  await expect(
    createCodeAttachmentsService({
      ...deps,
      authorizeWorkspace: undefined,
    }).budget(actor),
  ).rejects.toMatchObject({ code: "fault.attachment.budgetUnavailable" });
  expect(initializations).toBe(0);
  await expect(
    service.readForInput(actor, identity.sessionId, [
      { ref: "a", fileName: "a", mime: "text/plain", bytes: 0 },
      { ref: "b", fileName: "b", mime: "text/plain", bytes: 0 },
    ]),
  ).rejects.toMatchObject({ code: "proto.payloadTooLarge" });
  expect(writes).toBe(0);
  await service.close();
});

it("连接关闭发生在首Begin权威校验等待期间，迟到Begin不得返回staging或在新连接复活", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "kfw-code-attachments-close-"),
  );
  directories.push(directory);
  let enter: (() => void) | undefined;
  let resume: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const stored = repositoryFixture();
  const repository: CodeAttachmentRepository = {
    ...stored,
    async transact<T>(
      session: CodeAttachmentSession,
      key: string,
      operation: (transaction: CodeAttachmentTransaction) => Promise<T>,
    ) {
      return stored.transact<T>(session, key, (transaction) =>
        operation({
          ...transaction,
          async assertWritable(expected) {
            await transaction.assertWritable(expected);
            enter?.();
            await barrier;
          },
        }),
      );
    },
  };
  const settings = workspaceSettingsSchema.parse({ defaultModel: "fixture" });
  const service = createCodeAttachmentsService({
    repository,
    blob: createLocalFsBlobStore({
      rootDir: directory,
      publicBaseUrl: "http://localhost/blobs",
      signingSecret: "private-close-test",
    }),
    async authorizeSession() {
      return identity;
    },
    async authorizeRow() {
      throw new CodeAttachmentError(
        "fault.attachment.notAuthorized",
        "此关闭回归无消息附件。",
      );
    },
    async limits() {
      return codeAttachmentLimits(settings);
    },
  });
  const input = {
    sessionId: identity.sessionId,
    connectionId: "closing-connection",
    uploadId: "pending-upload",
    fileName: "empty.bin",
    mime: "application/octet-stream",
    totalBytes: 0,
    checksum: `sha256:${createHash("sha256").digest("hex")}`,
  };
  const pending = service.begin(actor, input);
  await entered;
  const closing = service.releaseConnection(
    identity.workspaceId,
    input.connectionId,
  );
  resume?.();
  await expect(pending).rejects.toMatchObject({
    code: "fault.attachment.interrupted",
  });
  await closing;
  await expect(
    service.begin(actor, { ...input, connectionId: "new-owned-connection" }),
  ).rejects.toMatchObject({ code: "fault.attachment.interrupted" });
  await service.close();
});

const actor: AuthenticatedUser = {
  id: "user-a",
  email: "human@test.example",
  accessToken: "token-a",
  userMetadata: {},
};
const identity: CodeAttachmentSession = {
  workspaceId: "workspace-a",
  projectId: "project-a",
  taskId: "task-a",
  sessionId: "task-a",
  userId: actor.id,
  scopeGeneration: 1,
  branchGeneration: 1,
  revision: 1,
  canUpload: true,
};

function repositoryFixture(): CodeAttachmentRepository {
  const records = new Map<string, CodeAttachmentRecord>();
  return {
    async transact<T>(
      _session: CodeAttachmentSession,
      key: string,
      operation: Parameters<CodeAttachmentRepository["transact"]>[2],
    ): Promise<T> {
      return (await operation({
        record: records.get(key) ?? null,
        async assertWritable(expected: CodeAttachmentSession) {
          expect(expected).toMatchObject(identity);
        },
        async save(record) {
          records.set(key, structuredClone(record));
        },
      })) as T;
    },
    async findCommitted(session, ref) {
      return (
        [...records.values()].find(
          (
            record,
          ): record is Extract<CodeAttachmentRecord, { status: "committed" }> =>
            record.status === "committed" &&
            record.ref === ref &&
            record.workspaceId === session.workspaceId &&
            record.projectId === session.projectId &&
            record.taskId === session.taskId &&
            record.sessionId === session.sessionId,
        ) ?? null
      );
    },
    async interruptStaging() {},
    async abortConnection() {},
    async close() {},
    async releaseTask() {},
    async purgeTask() {},
  };
}

it("真实附件事务提交后，重建服务仍由所属消息读取私有 bytes，其它 Task 无法使用该 ref", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kfw-code-attachments-"));
  directories.push(directory);
  const bytes = Buffer.from([0, 255, 1, 2]);
  const settings = workspaceSettingsSchema.parse({ defaultModel: "fixture" });
  const repository = repositoryFixture();
  let canonical:
    | { ref: string; fileName: string; mime: string; bytes: number }
    | undefined;
  const deps: CodeAttachmentsDeps = {
    blob: createLocalFsBlobStore({
      rootDir: directory,
      publicBaseUrl: "http://localhost/blobs",
      signingSecret: "private-test-secret",
    }),
    repository,
    async authorizeSession(_actor, sessionId) {
      return { ...identity, taskId: sessionId, sessionId };
    },
    async authorizeRow(_actor, request) {
      expect(request).toMatchObject({
        sessionId: "task-a",
        target: { rowId: 2, entityId: "input-a" },
        attachmentIndex: 0,
      });
      if (!canonical || request.ref !== canonical.ref)
        throw new Error("附件不属于该消息");
      return canonical;
    },
    async limits() {
      return codeAttachmentLimits(settings);
    },
  };
  const upload = {
    connectionId: "owned-connection",
    sessionId: "task-a",
    uploadId: "upload-a",
  };
  const service = createCodeAttachmentsService(deps);
  await service.initialize();
  expect(
    await service.begin(actor, {
      ...upload,
      fileName: "binary.dat",
      mime: "application/octet-stream",
      totalBytes: bytes.length,
      totalChunks: 1,
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }),
  ).toEqual({
    uploadId: "upload-a",
    state: "staging",
    nextChunkIndex: 0,
    chunkMaxBytes: settings.codeAttachmentChunkMaxBytes,
    totalChunks: 1,
  });
  expect(
    await service.chunk(actor, {
      ...upload,
      chunkIndex: 0,
      dataBase64: bytes.toString("base64"),
    }),
  ).toEqual({ uploadId: "upload-a", nextChunkIndex: 1 });
  const committed = await service.commit(actor, upload);
  canonical = {
    ref: committed.ref,
    fileName: "binary.dat",
    mime: "application/octet-stream",
    bytes: bytes.length,
  };
  expect(await service.commit(actor, upload)).toEqual(committed);
  const restarted = createCodeAttachmentsService(deps);
  await restarted.initialize();
  const read = await restarted.read(
    actor,
    {
      sessionId: "task-a",
      ref: committed.ref,
      target: { rowId: 2, entityId: "input-a" },
      attachmentIndex: 0,
      offset: 0,
      limit: bytes.length,
    },
    "share",
  );
  expect(read).toEqual({
    dataBase64: bytes.toString("base64"),
    mediaType: "application/octet-stream",
    totalBytes: bytes.length,
    nextOffset: null,
  });
  await expect(
    restarted.readForInput(actor, "task-b", [canonical]),
  ).rejects.toThrow("附件");
});
