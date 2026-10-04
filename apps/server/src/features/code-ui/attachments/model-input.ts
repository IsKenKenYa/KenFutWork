import type { ContentBlock } from "@langchain/core/messages";
import sharp from "sharp";
import { readPdf } from "../../code-tools/file-pdf.js";
import type { FileLimits } from "../../code-tools/file-types.js";
import type { TrustedCodeInput } from "./input-types.js";
import { CodeAttachmentError } from "./types.js";

/** Explicit human inputs are content, never a host path or an expanded sandbox grant. */
export async function codeInputContent(inputs: readonly TrustedCodeInput[], limits: FileLimits, capabilities: { image: boolean; pdf: boolean }, signal?: AbortSignal): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [];
  let totalBytes = 0;
  let characters = 0;
  for (const input of inputs) {
    signal?.throwIfAborted();
    totalBytes += input.bytes.length;
    if (input.bytes.length !== input.attachment.bytes || totalBytes > limits.codeReadMaxBytes)
      throw new CodeAttachmentError("fault.attachment.inputBudget", "附件输入超过当前读取预算，请调整治理设置或提交较小的文件。", 413);
    const mime = input.attachment.mime.split(";", 1)[0]!.trim().toLowerCase();
    if (mime === "application/pdf") {
      const pdf = await readPdf({ path: input.attachment.fileName, bytes: Buffer.from(input.bytes), version: input.attachment.ref }, { ...limits, codeReadPageCharacters: limits.codeReadPageCharacters - characters }, { path: input.attachment.fileName, capabilities, ...(signal ? { signal } : {}) });
      if (pdf.truncated) throw new CodeAttachmentError("fault.attachment.inputBudget", "PDF输入超过当前页数或内容预算，请调整治理设置或提交较小的文件。", 413);
      characters += Array.from(pdf.extractedText ?? "").length;
      for (const block of pdf.modelContent) {
        if (typeof block.type !== "string") throw new Error("PDF内容块缺少类型。");
        content.push({ ...block, type: block.type });
      }
      continue;
    }
    if (mime.startsWith("image/")) {
      if (!capabilities.image) throw new CodeAttachmentError("fault.attachment.imageUnsupported", "当前模型不支持图片输入，请选择支持图片的模型。", 400);
      const types: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
      const metadata = await sharp(input.bytes).metadata();
      if (!metadata.format || types[metadata.format] !== mime)
        throw new CodeAttachmentError("fault.attachment.invalidImage", "图片实际格式与附件声明不一致。", 400);
      content.push({ type: "image_url", image_url: `data:${mime};base64,${Buffer.from(input.bytes).toString("base64")}` });
      continue;
    }
    if (!mime.startsWith("text/") && !["application/json", "application/xml", "application/javascript", "application/x-yaml"].includes(mime))
      throw new CodeAttachmentError("fault.attachment.unsupportedInput", `当前附件类型不能作为模型文本输入：${input.attachment.fileName}。`, 400);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes); }
    catch { throw new CodeAttachmentError("fault.attachment.invalidText", "文本附件不是有效UTF-8，请转换后重新提交。", 400); }
    characters += Array.from(text).length;
    if (characters > limits.codeReadPageCharacters)
      throw new CodeAttachmentError("fault.attachment.inputBudget", "文本附件超过当前字符预算，请调整治理设置或提交较小的文件。", 413);
    content.push({ type: "text", text: `用户附件 ${JSON.stringify(input.attachment.fileName)}（${mime}）：\n${text}` });
  }
  return content;
}
