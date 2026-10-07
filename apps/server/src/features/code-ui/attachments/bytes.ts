import { createHash } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { CodeAttachmentError, type CodeAttachmentSession } from "./types.js";

export const attachmentChecksum = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const attachmentKey = (
  session: CodeAttachmentSession,
  uploadId: string,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        session.instanceId,
        session.projectId,
        session.taskId,
        session.sessionId,
        uploadId,
      ]),
    )
    .digest("hex");
export const attachmentFingerprint = (
  input: protocol.V4AttachmentBeginParams,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        input.fileName,
        input.mime,
        input.totalBytes,
        input.totalChunks ?? null,
        input.checksum,
      ]),
    )
    .digest("hex");

/** Fixed physical frames still bound allocation when configured chunk budgets are larger. */
export function attachmentFrameChunkBytes(input: {
  connectionId: string;
  sessionId: string;
  uploadId: string;
}): number {
  return attachmentFrameDataBytes({
    service: "zcodeAgentService",
    method: "attachmentChunkV4",
    connectionId: input.connectionId,
    args: [
      {
        sessionId: input.sessionId,
        uploadId: input.uploadId,
        chunkIndex: Number.MAX_SAFE_INTEGER,
        dataBase64: "",
      },
    ],
  });
}

export function attachmentFrameDataBytes(envelope: unknown): number {
  const overhead = Buffer.byteLength(JSON.stringify(envelope));
  // Base64 uses four characters per three decoded bytes; these are encoding constants.
  return Math.max(
    0,
    Math.floor((protocol.PROTOCOL_V4_LIMITS.maxFrameBytes - overhead) / 4) * 3,
  );
}

export function decodeAttachmentChunk(
  encoded: string,
  maximum: number,
): Buffer {
  // Budgets are checked before Buffer.from allocates decoded bytes.
  if (encoded.length > Math.ceil(maximum / 3) * 4 || encoded.length % 4 !== 0)
    throw new CodeAttachmentError(
      "proto.payloadTooLarge",
      "附件分块格式无效或超过工作区预算。",
      413,
    );
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  for (let index = 0; index < encoded.length - padding; index += 1) {
    const value = encoded.charCodeAt(index);
    if (
      !(
        (value >= 65 && value <= 90) ||
        (value >= 97 && value <= 122) ||
        (value >= 48 && value <= 57) ||
        value === 43 ||
        value === 47
      )
    )
      throw new CodeAttachmentError(
        "proto.invalidBase64",
        "附件分块 Base64 格式无效。",
        400,
      );
  }
  if ((encoded.length / 4) * 3 - padding > maximum)
    throw new CodeAttachmentError(
      "proto.payloadTooLarge",
      "附件分块超过工作区预算。",
      413,
    );
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded)
    throw new CodeAttachmentError(
      "proto.invalidBase64",
      "附件分块不是规范 Base64。",
      400,
    );
  return bytes;
}
