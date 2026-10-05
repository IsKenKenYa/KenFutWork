import type { InstanceSettings } from "@kenfutwork/shared";
import type { CodeAttachmentLimits } from "./types.js";

/** Settings resolve DB ?? env ?? governance defaults; adapters never restate defaults. */
export function codeAttachmentLimits(
  settings: InstanceSettings,
): CodeAttachmentLimits {
  return {
    maxBytes: settings.codeAttachmentMaxBytes,
    chunkMaxBytes: settings.codeAttachmentChunkMaxBytes,
    maxChunks: settings.codeAttachmentMaxChunks,
    maxConcurrent: settings.codeAttachmentMaxConcurrent,
    stagedMaxBytes: settings.codeAttachmentStagedMaxBytes,
    uploadTtlMs: settings.codeAttachmentUploadTtlMs,
    maxPerInput: settings.codeAttachmentMaxPerInput,
    maxRetries: settings.codeAttachmentMaxRetries,
    retryDelayMs: settings.codeAttachmentRetryDelayMs,
  };
}
