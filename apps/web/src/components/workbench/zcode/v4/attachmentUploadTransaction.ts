import { BufferWriter, serialize } from "@zcode/rpc";
import type {
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentTerminalParams,
} from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  type V4AttachmentBeginResult,
  type V4AttachmentChunkResult,
  type V4AttachmentPutParams,
  type V4AttachmentPutResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@zui/logger.js";

interface AttachmentUploadAgent {
  attachmentBeginV4(
    params: ZCodeAgentAttachmentBeginParams,
  ): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(
    params: ZCodeAgentAttachmentChunkParams,
  ): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(
    params: ZCodeAgentAttachmentTerminalParams,
  ): Promise<V4AttachmentPutResult>;
  attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams): Promise<void>;
}

interface AttachmentUploadWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface AttachmentUploadProgress {
  phase: "uploading" | "committing";
  uploadedBytes: number;
  totalBytes: number;
}

export interface AttachmentUploadOptions {
  /** Stable per-chip attempt identity; network retries reuse it, a manual retry creates a new one. */
  uploadId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: AttachmentUploadProgress) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Attachment upload canceled");
  error.name = "AbortError";
  throw error;
}

function decodeBase64(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodedBase64ByteLength(dataBase64: string): number {
  if (dataBase64.length === 0) return 0;
  if (dataBase64.length % 4 !== 0) throw new Error("proto.invalidBase64");
  const padding = dataBase64.endsWith("==")
    ? 2
    : dataBase64.endsWith("=")
      ? 1
      : 0;
  const contentLength = dataBase64.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = dataBase64.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) throw new Error("proto.invalidBase64");
  }
  for (let index = contentLength; index < dataBase64.length; index += 1) {
    if (dataBase64.charCodeAt(index) !== 61)
      throw new Error("proto.invalidBase64");
  }
  return (dataBase64.length / 4) * 3 - padding;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const callStackSafeChunk = 0x8000;
  for (let index = 0; index < bytes.length; index += callStackSafeChunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + callStackSafeChunk),
    );
  }
  return btoa(binary);
}

async function checksum(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error("fault.attachment.checksumUnavailable");
  // WebCrypto 的 BufferSource 要求 ArrayBuffer；复制也避免调用期间底层 view 被复用。
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function createUploadId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return `upload-${globalThis.crypto.randomUUID()}`;
  }
  const words = globalThis.crypto.getRandomValues(new Uint32Array(4));
  return `upload-${[...words].map((word) => word.toString(16).padStart(8, "0")).join("")}`;
}

/** 用 production ChannelClient 相同的 serializer 计量完整 method+args physical request。 */
function measureAttachmentChannelRequestBytes(
  method: string,
  params: unknown,
): number {
  const writer = new BufferWriter();
  // RequestType.Promise=100；max int id 比正常短生命周期 request id 更保守。
  serialize(writer, [100, 2_147_483_647, ServiceChannels.ZCodeAgent, method]);
  serialize(writer, [params]);
  return writer.buffer.byteLength;
}

function assertAttachmentChannelRequest(method: string, params: unknown): void {
  if (
    measureAttachmentChannelRequestBytes(method, params) >
    PROTOCOL_V4_LIMITS.maxFrameBytes
  ) {
    throw new Error("proto.frameTooLarge");
  }
}

export async function uploadAttachmentTransaction(
  agent: AttachmentUploadAgent,
  workspace: AttachmentUploadWorkspace,
  input: V4AttachmentPutParams,
  options: AttachmentUploadOptions = {},
): Promise<V4AttachmentPutResult> {
  throwIfAborted(options.signal);
  const decodedBytes = decodedBase64ByteLength(input.dataBase64);
  const bytes = decodeBase64(input.dataBase64);
  if (bytes.byteLength !== decodedBytes) throw new Error("proto.invalidBase64");
  const uploadId = options.uploadId ?? createUploadId();
  const common = { ...workspace, sessionId: input.sessionId, uploadId };
  const beginParams: ZCodeAgentAttachmentBeginParams = {
    ...common,
    fileName: input.fileName,
    mime: input.mime,
    totalBytes: decodedBytes,
    checksum: await checksum(bytes),
  };
  assertAttachmentChannelRequest("attachmentBeginV4", beginParams);

  let began = false;
  try {
    throwIfAborted(options.signal);
    const begin = await agent.attachmentBeginV4(beginParams);
    began = true;
    throwIfAborted(options.signal);
    if (begin.state === "committed") {
      options.onProgress?.({
        phase: "committing",
        uploadedBytes: decodedBytes,
        totalBytes: decodedBytes,
      });
      return { ref: begin.ref };
    }
    const chunkBytes = begin.chunkMaxBytes;
    const totalChunks = begin.totalChunks;
    if (
      !chunkBytes ||
      totalChunks === undefined ||
      !Number.isSafeInteger(chunkBytes) ||
      totalChunks !== Math.ceil(decodedBytes / chunkBytes) ||
      begin.nextChunkIndex > totalChunks
    ) {
      throw new Error("fault.attachment.invalidServerProgress");
    }
    options.onProgress?.({
      phase: "uploading",
      uploadedBytes: Math.min(
        begin.nextChunkIndex * chunkBytes,
        bytes.byteLength,
      ),
      totalBytes: bytes.byteLength,
    });
    for (
      let chunkIndex = begin.nextChunkIndex;
      chunkIndex < totalChunks;
      chunkIndex += 1
    ) {
      throwIfAborted(options.signal);
      const start = chunkIndex * chunkBytes;
      const chunkParams: ZCodeAgentAttachmentChunkParams = {
        ...common,
        chunkIndex,
        dataBase64: encodeBase64(
          bytes.subarray(start, Math.min(start + chunkBytes, bytes.length)),
        ),
      };
      assertAttachmentChannelRequest("attachmentChunkV4", chunkParams);
      const result = await agent.attachmentChunkV4(chunkParams);
      if (result.nextChunkIndex !== chunkIndex + 1) {
        throw new Error("fault.attachment.invalidServerProgress");
      }
      options.onProgress?.({
        phase: "uploading",
        uploadedBytes: Math.min(
          (chunkIndex + 1) * chunkBytes,
          bytes.byteLength,
        ),
        totalBytes: bytes.byteLength,
      });
    }
    throwIfAborted(options.signal);
    options.onProgress?.({
      phase: "committing",
      uploadedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
    });
    const terminal = common satisfies ZCodeAgentAttachmentTerminalParams;
    assertAttachmentChannelRequest("attachmentCommitV4", terminal);
    const committed = await agent.attachmentCommitV4(terminal);
    throwIfAborted(options.signal);
    return committed;
  } catch (error) {
    // 传输错误的回执可能丢失；保留同键 staging，由下一次 Begin 查询权威进度。
    if (began && options.signal?.aborted) {
      try {
        await agent.attachmentAbortV4(common);
      } catch (abortError) {
        logger.warn(
          "[v4-attachment] failed to abort upload transaction",
          abortError,
        );
      }
    }
    throw error;
  }
}
