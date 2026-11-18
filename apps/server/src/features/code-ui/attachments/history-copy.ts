import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { BlobBucket } from "../../blob/types.js";
import { attachmentChecksum, attachmentKey } from "./bytes.js";
import {
  CodeAttachmentError,
  type CodeAttachmentHistoryCopy,
  type CodeAttachmentRecord,
  type CodeAttachmentRepository,
  type CodeAttachmentSession,
} from "./types.js";

type Committed = Extract<CodeAttachmentRecord, { status: "committed" }>;

/** 只持有当前复制创建的目标路径；发表不做外部I/O，回滚不删除任何源对象。 */
type HistoryCopyInput = {
  source: CodeAttachmentSession;
  target: CodeAttachmentSession;
  attachments: readonly protocol.AttachmentRef[];
  bucket: BlobBucket;
  repository: Pick<CodeAttachmentRepository, "publishHistoryCopies">;
  assertOpen(): void;
  committed(ref: string): Promise<Committed>;
  bytes(record: Committed): Promise<Uint8Array>;
  planObject?: (path: string) => Promise<void>;
};

export async function prepareAttachmentHistory(
  input: HistoryCopyInput,
): Promise<CodeAttachmentHistoryCopy> {
  const { source, target } = input;
  if (
    source.instanceId !== target.instanceId ||
    source.projectId !== target.projectId ||
    source.taskId === target.taskId ||
    target.taskId !== target.sessionId ||
    !target.canUpload
  )
    throw new CodeAttachmentError(
      "fault.attachment.notAuthorized",
      "附件继承必须归属同一实例/项目的新根Task。",
      404,
    );
  const attachments = new Map<string, protocol.AttachmentRef>();
  const records: Committed[] = [];
  const paths: string[] = [];
  let state: "prepared" | "released" | "discarded" = "prepared";
  const discard = async () => {
    if (state !== "prepared") return;
    await input.bucket.remove(paths);
    state = "discarded";
  };
  try {
    for (const requested of input.attachments) {
      input.assertOpen();
      const existing = attachments.get(requested.ref);
      if (existing) {
        if (
          existing.fileName !== requested.fileName ||
          existing.mime !== requested.mime ||
          existing.bytes !== requested.bytes
        )
          throw new CodeAttachmentError(
            "fault.attachment.notAuthorized",
            "同一继承引用的正规元数据不一致。",
            404,
          );
        continue;
      }
      const copied = await copyAttachment(input, requested, paths);
      records.push(copied);
      attachments.set(requested.ref, {
        ref: copied.ref,
        fileName: copied.fileName,
        mime: copied.mime,
        bytes: copied.totalBytes,
      });
    }
  } catch (error) {
    try {
      await discard();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "附件历史准备失败，私有目标未全部确认清理。",
      );
    }
    throw error;
  }
  return {
    attachments,
    async publish(scoped) {
      input.assertOpen();
      if (state !== "prepared")
        throw new CodeAttachmentError(
          "fault.attachment.interrupted",
          "附件继承资源已释放。",
        );
      await input.repository.publishHistoryCopies(scoped, target, records);
    },
    release() {
      state = "released";
    },
    discard,
  };
}

async function copyAttachment(
  input: HistoryCopyInput,
  requested: protocol.AttachmentRef,
  paths: string[],
): Promise<Committed> {
  const { source, target } = input;
  const record = await input.committed(requested.ref);
  const ownSourcePath = `${source.instanceId}/${source.projectId}/${source.taskId}/${record.key}`;
  if (
    record.instanceId !== source.instanceId ||
    record.projectId !== source.projectId ||
    record.taskId !== source.taskId ||
    record.sessionId !== source.sessionId ||
    record.ref !== requested.ref ||
    record.ref !== `code-attachment:${record.key}` ||
    record.objectPath !== ownSourcePath ||
    record.fileName !== requested.fileName ||
    record.mime !== requested.mime ||
    record.totalBytes !== requested.bytes
  )
    throw new CodeAttachmentError(
      "fault.attachment.notAuthorized",
      "继承附件不属于该Task的正规私有对象。",
      404,
    );
  const bytes = await input.bytes(record);
  input.assertOpen();
  if (
    bytes.length !== record.totalBytes ||
    attachmentChecksum(bytes) !== record.checksum
  )
    throw new CodeAttachmentError(
      "fault.attachment.contentChanged",
      "源附件内容已改变，未发表新Task。",
    );
  // 源upload key作为不含内容的稳定复制项身份；目标Task由原command认领一次生成。
  const key = attachmentKey(target, record.key);
  const ref = `code-attachment:${key}`;
  const objectPath = `${target.instanceId}/${target.projectId}/${target.taskId}/${key}`;
  paths.push(objectPath); // I/O响应丢失也只清理本复制独占目标，不触碰源对象。
  await input.planObject?.(objectPath);
  await input.bucket.upload(objectPath, bytes, {
    contentType: record.mime,
    upsert: false,
  });
  input.assertOpen();
  return {
    ...record,
    ...target,
    key,
    ref,
    objectPath,
    status: "committed",
  };
}
