/* oxlint-disable eslint(max-lines) -- Composer 附件的收集、恢复和序列化必须共享同一套 MIME/大小边界。 */

import type {
  CreateTempTextAttachmentResult,
  ZCodePromptAttachment,
} from "@zcode/shared";
import type { V4AttachmentBudget } from "@zcode/shared/zcode-protocol-v4";
import {
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@zui/lib/chatAttachmentErrors.js";
import {
  basenameFromPath,
  countClipboardTextLines,
  createClipboardTextAttachmentFilename,
  inferAttachmentMimeType,
  isTextLikeAttachment,
} from "@zui/lib/chatAttachmentMetadata.js";
import { nanoid } from "nanoid";

export {
  MissingInlineImageContentError,
  MissingInlinePdfContentError,
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@zui/lib/chatAttachmentErrors.js";
export {
  countClipboardTextLines,
  formatAttachmentSize,
  shouldPreferSpreadsheetClipboardText,
} from "@zui/lib/chatAttachmentMetadata.js";

const LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD = 15 * 1024;

export type ChatComposerAttachmentSourceKind = "clipboard-text";

export interface ChatComposerAttachment {
  id: string;
  file?: File;
  filename: string;
  sourceKind?: ChatComposerAttachmentSourceKind;
  lineCount?: number;
  charCount?: number;
  mimeType: string;
  sizeBytes: number;
  objectUrl?: string;
  localPath?: string;
}

const PDF_MIME_TYPE = "application/pdf";

function normalizeComposerMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized === PDF_MIME_TYPE ? PDF_MIME_TYPE : mimeType;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("读取附件失败"));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("读取附件失败"));
    };
    reader.readAsDataURL(file);
  });
}

export function createChatComposerAttachment(
  file: File,
  localPath?: string,
): ChatComposerAttachment {
  const mimeType = normalizeComposerMimeType(
    file.type || inferAttachmentMimeType(file.name),
  );
  return {
    id: nanoid(),
    file,
    filename: file.name,
    ...(localPath ? { localPath } : {}),
    mimeType,
    objectUrl: URL.createObjectURL(file),
    sizeBytes: file.size,
  };
}

export function createChatComposerPathAttachment(
  localPath: string,
): ChatComposerAttachment {
  const filename = basenameFromPath(localPath);
  return {
    id: nanoid(),
    filename,
    localPath,
    mimeType: inferAttachmentMimeType(filename),
    sizeBytes: 0,
  };
}

export function createClipboardTextPathComposerAttachment(
  text: string,
  attachment: CreateTempTextAttachmentResult,
): ChatComposerAttachment {
  return {
    id: nanoid(),
    filename: attachment.filename,
    localPath: attachment.localPath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    charCount: text.length,
    lineCount: countClipboardTextLines(text),
    sourceKind: "clipboard-text",
  };
}

export function shouldCreateClipboardTextAttachment(text: string): boolean {
  return text.length >= LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD;
}

export function createClipboardTextAttachmentFilenameForDate(
  now: Date = new Date(),
): string {
  return createClipboardTextAttachmentFilename(now);
}

export function revokeChatComposerAttachment(
  attachment: ChatComposerAttachment,
) {
  if (attachment.objectUrl) {
    URL.revokeObjectURL(attachment.objectUrl);
  }
}

export async function serializeChatComposerAttachment(
  attachment: ChatComposerAttachment,
  budget: Pick<V4AttachmentBudget, "maxBytes">,
): Promise<ZCodePromptAttachment> {
  const mimeType = normalizeComposerMimeType(
    attachment.mimeType || inferAttachmentMimeType(attachment.filename),
  );
  if (attachment.sizeBytes > budget.maxBytes) {
    const details = {
      filename: attachment.filename,
      maxSizeBytes: budget.maxBytes,
      sizeBytes: attachment.sizeBytes,
    };
    if (mimeType.startsWith("image/"))
      throw new OversizedInlineImageAttachmentError(details);
    if (mimeType.startsWith("video/"))
      throw new OversizedInlineVideoAttachmentError(details);
    if (mimeType === PDF_MIME_TYPE)
      throw new OversizedInlinePdfAttachmentError(details);
    throw new Error(
      `附件超过工作区预算：${attachment.sizeBytes} / ${budget.maxBytes} bytes。`,
    );
  }
  if (attachment.localPath && !attachment.file) {
    throw new Error("本地文件导入尚不可用，请使用文件上传。");
  }
  if (mimeType.startsWith("image/")) {
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "image",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  // video：宿主预算在任何编码前校验。
  if (mimeType.startsWith("video/")) {
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "video",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  if (mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE) {
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "pdf",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  const textContent =
    attachment.file && isTextLikeAttachment(attachment)
      ? await readAttachmentText(attachment.file)
      : undefined;
  const dataBase64 =
    attachment.file && textContent === undefined
      ? await readAttachmentBase64(attachment)
      : undefined;
  return {
    kind: "file",
    filename: attachment.filename,
    mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(textContent === undefined ? {} : { textContent }),
    ...(dataBase64 === undefined ? {} : { dataBase64 }),
  };
}

async function readAttachmentBase64(
  attachment: ChatComposerAttachment,
): Promise<string> {
  if (!attachment.file) {
    throw new Error("附件缺少可读取内容");
  }
  const dataUrl = await readFileAsDataUrl(attachment.file);
  const base64MarkerIndex = dataUrl.indexOf(",");
  if (base64MarkerIndex === -1) {
    throw new Error("附件数据格式不正确");
  }
  return dataUrl.slice(base64MarkerIndex + 1);
}

export function isImageChatComposerAttachment(
  attachment: ChatComposerAttachment,
): boolean {
  return attachment.mimeType.startsWith("image/");
}

export function isVideoChatComposerAttachment(
  attachment: ChatComposerAttachment,
): boolean {
  return attachment.mimeType.startsWith("video/");
}

export function isPdfChatComposerAttachment(
  attachment: ChatComposerAttachment,
): boolean {
  return (
    attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE
  );
}

/** 图片与视频同属媒体组：输入框与消息流统一按媒体卡片渲染。 */
export function isMediaChatComposerAttachment(
  attachment: ChatComposerAttachment,
): boolean {
  return (
    isImageChatComposerAttachment(attachment) ||
    isVideoChatComposerAttachment(attachment)
  );
}

async function readAttachmentText(file: File): Promise<string> {
  return file.text();
}
