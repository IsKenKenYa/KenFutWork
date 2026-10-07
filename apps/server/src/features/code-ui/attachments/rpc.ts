import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { z } from "zod";
import type { LocalActor } from "../../local-instance/types.js";
import { attachmentFrameDataBytes } from "./bytes.js";
import { CodeAttachmentError, type CodeAttachmentsService } from "./types.js";

const methods = new Set([
  "attachmentBudgetV4",
  "attachmentBeginV4",
  "attachmentChunkV4",
  "attachmentCommitV4",
  "attachmentAbortV4",
  "attachmentReadV4",
  "attachmentPreviewSourceV4",
  "conversationAttachmentReadV4",
  "conversationAttachmentStatV4",
]);

export const isCodeAttachmentRpc = (method: string): boolean =>
  methods.has(method);

/** Original RPC names and shapes; the carrier supplies connection identity, never renderer data. */
export async function codeAttachmentsRpc(
  service: CodeAttachmentsService,
  actor: LocalActor,
  method: string,
  args: unknown[],
  connectionId: string,
): Promise<{ result: unknown } | null> {
  if (!methods.has(method)) return null;
  if (!connectionId)
    throw new CodeAttachmentError(
      "fault.attachment.notAuthorized",
      "附件 RPC 缺少可信连接。",
      404,
    );
  if (
    Buffer.byteLength(
      JSON.stringify({
        service: "zcodeAgentService",
        method,
        args,
        connectionId,
      }),
    ) > protocol.PROTOCOL_V4_LIMITS.maxFrameBytes
  )
    throw new CodeAttachmentError(
      "proto.frameTooLarge",
      "附件 RPC 超过固定协议帧护栏。",
      413,
    );
  const value = z.record(z.string(), z.unknown()).parse(args[0]);
  if (method === "attachmentBudgetV4")
    return {
      result: await service.budget(
        actor,
        value.sessionId === undefined
          ? undefined
          : z.string().min(1).parse(value.sessionId),
      ),
    };
  if (value.connectionId !== undefined && value.connectionId !== connectionId)
    throw new CodeAttachmentError(
      "fault.attachment.notAuthorized",
      "附件连接身份不能由请求覆盖。",
      404,
    );
  const common = {
    connectionId,
    sessionId: value.sessionId,
    uploadId: value.uploadId,
  };
  if (method === "attachmentBeginV4")
    return {
      result: await service.begin(
        actor,
        protocol.v4AttachmentBeginParamsSchema.parse({
          ...common,
          fileName: value.fileName,
          mime: value.mime,
          totalBytes: value.totalBytes,
          totalChunks: value.totalChunks,
          checksum: value.checksum,
        }),
        attachmentFrameDataBytes({
          service: "zcodeAgentService",
          method: "attachmentChunkV4",
          connectionId,
          args: [
            { ...value, chunkIndex: Number.MAX_SAFE_INTEGER, dataBase64: "" },
          ],
        }),
      ),
    };
  if (method === "attachmentChunkV4")
    return {
      result: await service.chunk(
        actor,
        protocol.v4AttachmentChunkParamsSchema.parse({
          ...common,
          chunkIndex: value.chunkIndex,
          dataBase64: value.dataBase64,
        }),
      ),
    };
  if (method === "attachmentCommitV4")
    return {
      result: await service.commit(
        actor,
        protocol.v4AttachmentCommitParamsSchema.parse(common),
      ),
    };
  if (method === "attachmentAbortV4") {
    await service.abort(
      actor,
      protocol.v4AttachmentAbortParamsSchema.parse(common),
    );
    return { result: null };
  }
  const read = {
    sessionId: value.sessionId,
    ref: value.ref,
    ...(value.target !== undefined ? { target: value.target } : {}),
    ...(value.attachmentIndex !== undefined
      ? { attachmentIndex: value.attachmentIndex }
      : {}),
  };
  if (method === "attachmentPreviewSourceV4")
    return {
      result: await service.previewSource(
        actor,
        protocol.v4AttachmentPreviewSourceParamsSchema.parse({
          ...read,
          clientMode: "web-remote-replayable",
        }),
      ),
    };
  if (method === "conversationAttachmentStatV4")
    return {
      result: await service.stat(
        actor,
        protocol.v4ConversationAttachmentStatParamsSchema.parse(read),
      ),
    };
  const input = { ...read, offset: value.offset, limit: value.limit };
  return {
    result: await service.read(
      actor,
      method === "conversationAttachmentReadV4"
        ? protocol.v4ConversationAttachmentReadParamsSchema.parse(input)
        : protocol.v4AttachmentReadParamsSchema.parse(input),
      method === "conversationAttachmentReadV4" ? "share" : "preview",
    ),
  };
}
