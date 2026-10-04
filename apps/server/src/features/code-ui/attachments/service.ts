import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import {
  attachmentChecksum,
  attachmentFingerprint,
  attachmentFrameChunkBytes,
  attachmentKey,
  decodeAttachmentChunk,
} from "./bytes.js";
import { abortedAttachment } from "./repository.js";
import {
  CodeAttachmentError,
  type CodeAttachmentRecord,
  type CodeAttachmentSession,
  type CodeAttachmentsDeps,
  type CodeAttachmentsService,
} from "./types.js";

type StagingRecord = Extract<CodeAttachmentRecord, { status: "staging" }>;
type CommittedRecord = Extract<CodeAttachmentRecord, { status: "committed" }>;
interface Staging {
  record: StagingRecord;
  chunks: Buffer[];
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}
const interrupted = () =>
  new CodeAttachmentError(
    "fault.attachment.interrupted",
    "上传已中断，请重新选择附件。",
  );

export function createCodeAttachmentsService(
  deps: CodeAttachmentsDeps,
): CodeAttachmentsService {
  const runtimeId = randomUUID();
  const clock = deps.clock ?? Date.now;
  const bucket = deps.blob.bucket("code-attachments");
  const staging = new Map<string, Staging>();
  const locks = new Map<string, Promise<unknown>>();
  const closedConnections = new Set<string>();
  let initialized: Promise<void> | undefined;
  let closed = false;
  let releaseSerial = 0;
  const releasedTasks = new Map<string, number>();
  const taskKey = (workspaceId: string, taskId: string) =>
    JSON.stringify([workspaceId, taskId]);
  const connectionClosed = (workspaceId: string, connectionId: string) =>
    closed ||
    closedConnections.has(JSON.stringify([workspaceId, connectionId]));

  async function exclusive<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    locks.set(workspaceId, next);
    try {
      return await next;
    } finally {
      if (locks.get(workspaceId) === next) locks.delete(workspaceId);
    }
  }
  function discard(key: string) {
    const entry = staging.get(key);
    if (entry) clearTimeout(entry.timer);
    staging.delete(key);
  }
  async function initialize() {
    if (closed) throw interrupted();
    initialized ??= deps.repository.interruptStaging(runtimeId);
    return initialized;
  }
  async function session(
    actor: Parameters<CodeAttachmentsService["begin"]>[0],
    sessionId: string,
  ) {
    await initialize();
    return ownedSession(actor, sessionId);
  }
  async function ownedSession(
    actor: Parameters<CodeAttachmentsService["begin"]>[0],
    sessionId: string,
  ) {
    const identity = await deps.authorizeSession(actor, sessionId);
    if (identity.sessionId !== sessionId || identity.userId !== actor.id)
      throw new CodeAttachmentError(
        "fault.attachment.notAuthorized",
        "附件身份不属于当前用户会话。",
        404,
      );
    return identity;
  }
  async function expire(entry: Staging) {
    await exclusive(entry.record.workspaceId, async () => {
      await deps.repository.transact(
        entry.record,
        entry.record.key,
        async (transaction) => {
          if (
            transaction.record?.status === "staging" &&
            transaction.record.runtimeId === runtimeId
          )
            await transaction.save(abortedAttachment(transaction.record));
        },
      );
      discard(entry.record.key);
    });
  }
  function requireStage(
    record: CodeAttachmentRecord | null,
    connectionId: string,
  ): Staging {
    if (
      record?.status !== "staging" ||
      record.runtimeId !== runtimeId ||
      record.connectionId !== connectionId
    )
      throw interrupted();
    const entry = staging.get(record.key);
    if (!entry || record.expiresAt <= clock()) throw interrupted();
    return entry;
  }
  async function committed(
    identity: CodeAttachmentSession,
    ref: string,
  ): Promise<CommittedRecord> {
    const record = await deps.repository.findCommitted(identity, ref);
    if (!record)
      throw new CodeAttachmentError(
        "fault.attachment.notAuthorized",
        "附件不属于当前 Task 或尚未提交。",
        404,
      );
    return record;
  }
  async function bytesFor(
    actor: Parameters<CodeAttachmentsService["read"]>[0],
    identity: CodeAttachmentSession,
    record: CommittedRecord,
  ) {
    const limits = await deps.limits(actor, identity.workspaceId);
    if (
      record.totalBytes > limits.maxBytes ||
      record.totalBytes > limits.stagedMaxBytes
    )
      throw new CodeAttachmentError(
        "proto.payloadTooLarge",
        "附件超过当前工作区读取预算。",
        413,
      );
    const bytes = await bucket.download(record.objectPath, {
      maxBytes: record.totalBytes,
    });
    if (
      bytes.length !== record.totalBytes ||
      attachmentChecksum(bytes) !== record.checksum
    )
      throw new CodeAttachmentError(
        "fault.attachment.contentChanged",
        "已提交附件内容发生变化，拒绝读取。",
      );
    return bytes;
  }
  async function authorizeRow(
    actor: Parameters<CodeAttachmentsService["read"]>[0],
    input: {
      sessionId: string;
      ref: string;
      target?: protocol.ConversationRowTarget | undefined;
      attachmentIndex?: number | undefined;
    },
    purpose: "preview" | "share",
  ) {
    const identity = await session(actor, input.sessionId);
    const canonical = await deps.authorizeRow(actor, {
      sessionId: input.sessionId,
      ref: input.ref,
      target: input.target,
      attachmentIndex: input.attachmentIndex,
      purpose,
    });
    const record = await committed(identity, input.ref);
    if (
      canonical.ref !== record.ref ||
      canonical.bytes !== record.totalBytes ||
      canonical.mime !== record.mime ||
      canonical.fileName !== record.fileName
    )
      throw new CodeAttachmentError(
        "fault.attachment.notAuthorized",
        "附件展示身份不匹配所属消息。",
        404,
      );
    return { identity, record };
  }
  const service: CodeAttachmentsService = {
    initialize,
    async budget(actor, sessionId) {
      const workspaceId = sessionId
        ? (await ownedSession(actor, sessionId)).workspaceId
        : await deps.authorizeWorkspace?.(actor);
      if (!workspaceId)
        throw new CodeAttachmentError(
          "fault.attachment.budgetUnavailable",
          "附件预算的工作区身份提供方不可用。",
          503,
        );
      return deps.limits(actor, workspaceId);
    },
    async close() {
      closed = true;
      for (const entry of [...staging.values()])
        await service.releaseConnection(
          entry.record.workspaceId,
          entry.record.connectionId,
        );
      await deps.repository.close();
    },
    async begin(actor, raw, chunkFrameMaxBytes) {
      const input = protocol.v4AttachmentBeginParamsSchema.parse(raw);
      const admittedBeforeRelease = releaseSerial;
      const identity = await session(actor, input.sessionId);
      const limits = await deps.limits(actor, identity.workspaceId);
      const key = attachmentKey(identity, input.uploadId);
      const fingerprint = attachmentFingerprint(input);
      const admissionClosed = () =>
        connectionClosed(identity.workspaceId, input.connectionId) ||
        (releasedTasks.get(taskKey(identity.workspaceId, identity.taskId)) ??
          0) > admittedBeforeRelease;
      const decision = await exclusive<
        protocol.V4AttachmentBeginResult | { error: CodeAttachmentError }
      >(identity.workspaceId, async () => {
        const result = await deps.repository.transact<
          protocol.V4AttachmentBeginResult | { error: CodeAttachmentError }
        >(identity, key, async (transaction) => {
          const previous = transaction.record;
          if (previous?.status === "aborted") throw interrupted();
          if (previous && previous.fingerprint !== fingerprint)
            throw new CodeAttachmentError(
              "fault.attachment.uploadConflict",
              "同一上传键不能提交不同附件参数。",
            );
          if (previous?.status === "committed")
            return {
              uploadId: input.uploadId,
              state: "committed",
              nextChunkIndex: previous.totalChunks,
              ref: previous.ref,
            };
          const cancel = async () => {
            await transaction.save(
              abortedAttachment(
                previous ?? { ...identity, key, status: "aborted" },
              ),
            );
            return { error: interrupted() };
          };
          if (
            previous?.status === "staging" &&
            previous.connectionId !== input.connectionId
          )
            throw interrupted();
          if (admissionClosed()) return cancel();
          if (previous) {
            const entry = requireStage(previous, input.connectionId);
            return {
              uploadId: input.uploadId,
              state: "staging",
              nextChunkIndex: entry.chunks.length,
              chunkMaxBytes: previous.chunkMaxBytes,
              totalChunks: previous.totalChunks,
            };
          }
          await transaction.assertWritable(identity);
          if (admissionClosed()) return cancel();
          const owned = [...staging.values()].filter(
            (entry) => entry.record.workspaceId === identity.workspaceId,
          );
          const chunkMaxBytes = Math.min(
            limits.chunkMaxBytes,
            attachmentFrameChunkBytes(input),
            chunkFrameMaxBytes ?? Number.POSITIVE_INFINITY,
          );
          const totalChunks =
            chunkMaxBytes > 0
              ? Math.ceil(input.totalBytes / chunkMaxBytes)
              : Number.POSITIVE_INFINITY;
          if (
            input.totalBytes > limits.maxBytes ||
            input.totalBytes +
              owned.reduce((sum, entry) => sum + entry.record.totalBytes, 0) >
              limits.stagedMaxBytes ||
            owned.length >= limits.maxConcurrent ||
            totalChunks > limits.maxChunks ||
            (input.totalChunks !== undefined &&
              input.totalChunks !== totalChunks)
          )
            throw new CodeAttachmentError(
              "proto.payloadTooLarge",
              "附件容量、分块数量或并发超过工作区预算。",
              413,
            );
          const record: StagingRecord = {
            ...identity,
            key,
            status: "staging",
            connectionId: input.connectionId,
            runtimeId,
            fileName: input.fileName,
            mime: input.mime,
            totalBytes: input.totalBytes,
            totalChunks,
            checksum: input.checksum,
            fingerprint,
            expiresAt: clock() + limits.uploadTtlMs,
            chunkMaxBytes,
          };
          await transaction.save(record);
          if (admissionClosed()) return cancel();
          const timer = setTimeout(() => {
            const entry = staging.get(key);
            if (entry)
              void expire(entry).catch((error: unknown) =>
                console.error("[code-attachments] 上传中断标记失败", error),
              );
          }, limits.uploadTtlMs);
          timer.unref();
          staging.set(key, { record, chunks: [], bytes: 0, timer });
          return {
            uploadId: input.uploadId,
            state: "staging",
            nextChunkIndex: 0,
            chunkMaxBytes,
            totalChunks,
          };
        });
        // DB commit is also an await boundary; never ACK a new stage after its carrier closed.
        if (
          "error" in result ||
          result.state !== "staging" ||
          !admissionClosed()
        )
          return result;
        await deps.repository.transact(identity, key, async (transaction) => {
          if (
            transaction.record?.status === "staging" &&
            transaction.record.connectionId === input.connectionId
          )
            await transaction.save(abortedAttachment(transaction.record));
        });
        discard(key);
        return { error: interrupted() };
      });
      if ("error" in decision) throw decision.error;
      return decision;
    },
    async chunk(actor, input) {
      const identity = await session(actor, input.sessionId);
      const key = attachmentKey(identity, input.uploadId);
      const limits = await deps.limits(actor, identity.workspaceId);
      return exclusive(identity.workspaceId, () =>
        deps.repository.transact(identity, key, async (transaction) => {
          const entry = requireStage(transaction.record, input.connectionId);
          await transaction.assertWritable(entry.record);
          const bytes = decodeAttachmentChunk(
            input.dataBase64,
            Math.min(limits.chunkMaxBytes, entry.record.chunkMaxBytes),
          );
          protocol.v4AttachmentChunkParamsSchema.parse(input);
          const previous = entry.chunks[input.chunkIndex];
          if (previous) {
            if (!previous.equals(bytes))
              throw new CodeAttachmentError(
                "fault.attachment.chunkConflict",
                "同一分块下标不能提交不同内容。",
              );
            return {
              uploadId: input.uploadId,
              nextChunkIndex: entry.chunks.length,
            };
          }
          const expectedBytes = Math.min(
            entry.record.chunkMaxBytes,
            entry.record.totalBytes - entry.bytes,
          );
          if (
            input.chunkIndex !== entry.chunks.length ||
            input.chunkIndex >= entry.record.totalChunks ||
            bytes.length !== expectedBytes
          )
            throw new CodeAttachmentError(
              "fault.attachment.invalidChunk",
              "附件分块顺序或字节数不匹配。",
              400,
            );
          entry.chunks.push(bytes);
          entry.bytes += bytes.length;
          return {
            uploadId: input.uploadId,
            nextChunkIndex: entry.chunks.length,
          };
        }),
      );
    },
    async commit(actor, input) {
      protocol.v4AttachmentCommitParamsSchema.parse(input);
      const identity = await session(actor, input.sessionId);
      const key = attachmentKey(identity, input.uploadId);
      const limits = await deps.limits(actor, identity.workspaceId);
      const result = await exclusive(identity.workspaceId, () =>
        deps.repository.transact(identity, key, async (transaction) => {
          const previous = transaction.record;
          if (previous?.status === "committed") return { ref: previous.ref };
          const entry = requireStage(previous, input.connectionId);
          if (
            entry.record.totalBytes > limits.maxBytes ||
            entry.record.totalBytes > limits.stagedMaxBytes ||
            entry.record.totalChunks > limits.maxChunks
          ) {
            await transaction.save(abortedAttachment(entry.record));
            return {
              error: new CodeAttachmentError(
                "proto.payloadTooLarge",
                "附件超过已收紧的工作区预算。",
                413,
              ),
            };
          }
          if (
            entry.chunks.length !== entry.record.totalChunks ||
            entry.bytes !== entry.record.totalBytes
          )
            throw new CodeAttachmentError(
              "fault.attachment.incomplete",
              "附件分块尚未全部提交。",
            );
          try {
            await transaction.assertWritable(entry.record);
          } catch (error) {
            await transaction.save(abortedAttachment(entry.record));
            return { error };
          }
          const bytes = Buffer.concat(entry.chunks, entry.bytes);
          if (attachmentChecksum(bytes) !== entry.record.checksum) {
            await transaction.save(abortedAttachment(entry.record));
            return {
              error: new CodeAttachmentError(
                "fault.attachment.checksumMismatch",
                "附件完整性校验失败。",
                400,
              ),
            };
          }
          const ref = `code-attachment:${key}`;
          const objectPath = `${identity.workspaceId}/${identity.projectId}/${identity.taskId}/${key}`;
          await bucket.upload(objectPath, bytes, {
            contentType: entry.record.mime,
            upsert: true,
          });
          try {
            await transaction.assertWritable(entry.record);
          } catch (error) {
            await bucket.remove([objectPath]);
            await transaction.save(abortedAttachment(entry.record));
            return { error };
          }
          const {
            connectionId: _connection,
            runtimeId: _runtime,
            ...metadata
          } = entry.record;
          try {
            await transaction.save({
              ...metadata,
              status: "committed",
              ref,
              objectPath,
            });
          } catch (error) {
            if (
              !(error instanceof CodeAttachmentError) ||
              error.code !== "fault.attachment.hostUnavailable"
            )
              throw error;
            await bucket.remove([objectPath]);
            await transaction.save(abortedAttachment(entry.record));
            return { error };
          }
          return { ref };
        }),
      );
      discard(key);
      if ("error" in result) throw result.error;
      return result;
    },
    async abort(actor, input) {
      protocol.v4AttachmentAbortParamsSchema.parse(input);
      const identity = await session(actor, input.sessionId);
      const key = attachmentKey(identity, input.uploadId);
      await exclusive(identity.workspaceId, () =>
        deps.repository.transact(identity, key, async (transaction) => {
          const record = transaction.record;
          if (record?.status === "committed" || record?.status === "aborted")
            return;
          if (record && record.connectionId !== input.connectionId)
            throw new CodeAttachmentError(
              "fault.attachment.notAuthorized",
              "上传不属于该连接。",
              404,
            );
          await transaction.save(
            abortedAttachment(
              record ?? { ...identity, key, status: "aborted" },
            ),
          );
          discard(key);
        }),
      );
    },
    async releaseConnection(workspaceId, connectionId) {
      closedConnections.add(JSON.stringify([workspaceId, connectionId]));
      await exclusive(workspaceId, async () => {
        await deps.repository.abortConnection(
          workspaceId,
          connectionId,
          runtimeId,
        );
        for (const [key, entry] of staging)
          if (
            entry.record.workspaceId === workspaceId &&
            entry.record.connectionId === connectionId
          )
            discard(key);
      });
    },
    async releaseTask(workspaceId, taskId) {
      // A trusted local admission sequence fences even Begin calls still resolving identity.
      releasedTasks.set(taskKey(workspaceId, taskId), ++releaseSerial);
      await exclusive(workspaceId, async () => {
        await deps.repository.releaseTask(workspaceId, taskId, runtimeId);
        for (const [key, entry] of staging)
          if (
            entry.record.workspaceId === workspaceId &&
            entry.record.taskId === taskId
          )
            discard(key);
      });
    },
    async purgeTask(actor, taskId, expectedScopeGeneration) {
      const identity = await session(actor, taskId);
      if (identity.taskId !== taskId || identity.sessionId !== taskId)
        throw new CodeAttachmentError(
          "fault.attachment.notAuthorized",
          "附件清理只接受根 Task。",
          404,
        );
      await service.releaseTask(identity.workspaceId, taskId);
      const limits = await deps.limits(actor, identity.workspaceId);
      await deps.repository.purgeTask(
        identity,
        expectedScopeGeneration,
        limits.maxConcurrent,
        async (records) => {
          const paths = records.map((record) => {
            const ownPath = `${identity.workspaceId}/${identity.projectId}/${identity.taskId}/${record.key}`;
            if (
              record.workspaceId !== identity.workspaceId ||
              record.projectId !== identity.projectId ||
              record.taskId !== identity.taskId ||
              record.ref !== `code-attachment:${record.key}` ||
              record.objectPath !== ownPath
            )
              throw new CodeAttachmentError(
                "fault.attachment.notAuthorized",
                "附件清理目标不是该 Task 的私有对象。",
                404,
              );
            return ownPath;
          });
          await bucket.remove(paths);
        },
      );
    },
    async read(actor, raw, purpose = "preview") {
      const input =
        purpose === "share"
          ? protocol.v4ConversationAttachmentReadParamsSchema.parse(raw)
          : protocol.v4AttachmentReadParamsSchema.parse(raw);
      const { identity, record } = await authorizeRow(actor, input, purpose);
      const bytes = await bytesFor(actor, identity, record);
      const limits = await deps.limits(actor, identity.workspaceId);
      const limit = Math.min(
        input.limit,
        limits.chunkMaxBytes,
        attachmentFrameChunkBytes({
          connectionId: "",
          sessionId: input.sessionId,
          uploadId: record.key,
        }),
      );
      if (input.offset > bytes.length)
        throw new CodeAttachmentError(
          "fault.attachment.invalidOffset",
          "附件读取位置超过内容长度。",
          400,
        );
      const end = Math.min(bytes.length, input.offset + limit);
      await authorizeRow(actor, input, purpose);
      const result = {
        dataBase64: Buffer.from(bytes.subarray(input.offset, end)).toString(
          "base64",
        ),
        mediaType: record.mime,
        totalBytes: bytes.length,
        nextOffset: end < bytes.length ? end : null,
      };
      return purpose === "share"
        ? protocol.v4ConversationAttachmentReadResultSchema.parse(result)
        : protocol.v4AttachmentReadResultSchema.parse(result);
    },
    async stat(actor, raw) {
      const input =
        protocol.v4ConversationAttachmentStatParamsSchema.parse(raw);
      const { record } = await authorizeRow(actor, input, "share");
      return protocol.v4ConversationAttachmentStatResultSchema.parse({
        mediaType: record.mime,
        totalBytes: record.totalBytes,
      });
    },
    async previewSource(actor, raw) {
      const input = protocol.v4AttachmentPreviewSourceParamsSchema.parse(raw);
      await authorizeRow(actor, input, "preview");
      // 私有 Blob 不暴露宿主路径；原 renderer 已支持 chunked 分支。
      return { kind: "chunked" };
    },
    async readForInput(actor, sessionId, attachments) {
      const identity = await session(actor, sessionId);
      const limits = await deps.limits(actor, identity.workspaceId);
      if (attachments.length > limits.maxPerInput)
        throw new CodeAttachmentError(
          "proto.payloadTooLarge",
          "本次输入的附件数量超过工作区预算。",
          413,
        );
      const result: Array<{
        attachment: protocol.AttachmentRef;
        bytes: Uint8Array;
      }> = [];
      let totalBytes = 0;
      for (const attachment of attachments) {
        const record = await committed(identity, attachment.ref);
        totalBytes += record.totalBytes;
        if (
          totalBytes > limits.stagedMaxBytes ||
          attachment.bytes !== record.totalBytes ||
          attachment.mime !== record.mime ||
          attachment.fileName !== record.fileName
        )
          throw new CodeAttachmentError(
            "fault.attachment.notAuthorized",
            "附件内容或累计读取预算不匹配。",
            404,
          );
        result.push({
          attachment: {
            ref: record.ref,
            fileName: record.fileName,
            mime: record.mime,
            bytes: record.totalBytes,
          },
          bytes: await bytesFor(actor, identity, record),
        });
      }
      return result;
    },
  };
  return service;
}
