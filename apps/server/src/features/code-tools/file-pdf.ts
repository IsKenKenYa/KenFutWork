import { createRequire } from "node:module";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { FileLimits, MediaFile, MediaReadInput } from "./file-types.js";

export interface BinaryFile {
  path: string;
  bytes: Buffer;
  version: string;
}

/**
 * 懒加载 `@napi-rs/canvas`（**不能在模块顶层静态 import**）。
 *
 * 与 node-pty / sharp 同一套办法：随包分发时它是 external 原生模块，必须走
 * `<exe>/node_modules/` 在运行时解析；打包成单文件 SEA 后，顶层静态 import 会被换成
 * SEA 的内建 `require`——它只认内置模块，加载期直接抛 `ERR_UNKNOWN_BUILTIN_MODULE`
 * **把整个服务端拖死**（2026-10-09 打包冒烟实测：装好的桌面端起不来）。
 * 懒加载后影响只落在「PDF 渲染成图」这一条路径：真缺组件时给可读原因，文本读取照常。
 */
let cachedCanvas: typeof import("@napi-rs/canvas") | null | undefined;

function loadCanvas(): typeof import("@napi-rs/canvas") {
  if (cachedCanvas === undefined) {
    try {
      cachedCanvas = createRequire(import.meta.url)(
        "@napi-rs/canvas",
      ) as typeof import("@napi-rs/canvas");
    } catch {
      cachedCanvas = null;
    }
  }
  if (!cachedCanvas) {
    throw new Error(
      "本机缺少 PDF 图片渲染组件（@napi-rs/canvas），请改用文本方式读取该 PDF。",
    );
  }
  return cachedCanvas;
}

type RenderInput = Parameters<PDFPageProxy["render"]>[0];

async function rasterPages(
  document: PDFDocumentProxy,
  binary: BinaryFile,
  limits: FileLimits,
  start: number,
  end: number,
  result: MediaFile,
  signal?: AbortSignal,
): Promise<MediaFile> {
  const { createCanvas } = loadCanvas();
  const maxPage = Math.min(end, start + limits.codePdfMaxPages - 1);
  let bytes = 0;
  result.modelContent = [
    {
      type: "text",
      text: `PDF ${binary.path}，共 ${document.numPages} 页。以下为所选页：`,
    },
  ];
  for (let number = start; number <= maxPage; number += 1) {
    signal?.throwIfAborted();
    const page = await document.getPage(number);
    try {
      const viewport = page.getViewport({ scale: limits.codePdfRenderScale });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      const rendering = page.render({
        canvas: canvas as unknown as RenderInput["canvas"],
        canvasContext: canvas.getContext(
          "2d",
        ) as unknown as RenderInput["canvasContext"],
        viewport,
      });
      const cancel = () => rendering.cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        await rendering.promise;
        signal?.throwIfAborted();
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      const png = canvas.toBuffer("image/png");
      if (bytes + png.length > limits.codeReadMaxBytes) {
        if (number === start)
          throw new Error(
            "PDF 单页图片超过读取预算，请调低渲染比例或调整治理设置",
          );
        result.pdfContinuation = {
          page: number,
          character: 0,
          version: binary.version,
        };
        break;
      }
      bytes += png.length;
      result.modelContent.push(
        { type: "text", text: `第 ${number} 页` },
        {
          type: "image",
          source_type: "base64",
          mime_type: "image/png",
          data: png.toString("base64"),
        },
      );
      if (number === maxPage && number < end)
        result.pdfContinuation = {
          page: number + 1,
          character: 0,
          version: binary.version,
        };
    } finally {
      page.cleanup();
    }
  }
  result.truncated = result.pdfContinuation !== undefined;
  if (result.pdfContinuation)
    result.modelContent.push({
      type: "text",
      text: `继续读取：${JSON.stringify(result.pdfContinuation)}`,
    });
  return result;
}

function pageRange(
  input: MediaReadInput,
  total: number,
): { start: number; end: number } {
  const match =
    input.pages === undefined
      ? undefined
      : /^(\d+)(?:-(\d+))?$/.exec(input.pages.trim());
  if (input.pages !== undefined && !match)
    throw new Error("PDF 页码需为单页或连续范围，如 1 或 1-5");
  const start = match ? Number(match[1]) : 1;
  const end = match ? Number(match[2] ?? match[1]) : total;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end > total
  )
    throw new Error(`PDF 页码范围无效，共 ${total} 页`);
  return { start, end };
}

export async function readPdf(
  binary: BinaryFile,
  limits: FileLimits,
  input: MediaReadInput,
): Promise<MediaFile> {
  input.signal?.throwIfAborted();
  const task = getDocument({
    data: new Uint8Array(binary.bytes),
    useSystemFonts: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  });
  let destroying: Promise<void> | undefined;
  const abort = () => {
    destroying = task.destroy();
    void destroying.catch(() => {});
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const document = await task.promise.catch(async (error) => {
    input.signal?.removeEventListener("abort", abort);
    await destroying;
    input.signal?.throwIfAborted();
    throw error;
  });
  try {
    const range = pageRange(input, document.numPages);
    if (
      input.pdfContinuation &&
      input.pdfContinuation.version !== binary.version
    )
      throw new Error("PDF 版本已变化，请重新读取");
    const start = input.pdfContinuation?.page ?? range.start;
    if (start < range.start || start > range.end)
      throw new Error("PDF 继续指针页码无效");
    const base64 = binary.bytes.toString("base64");
    const canonicalOutput = {
      type: "pdf",
      filePath: binary.path,
      base64,
      originalSize: binary.bytes.length,
      ...(input.pages ? { pages: input.pages } : {}),
    };
    const result: MediaFile = {
      ...canonicalOutput,
      type: "pdf",
      filePath: binary.path,
      version: binary.version,
      mimeType: "application/pdf",
      numPages: document.numPages,
      canonicalOutput,
      preview: {
        path: binary.path,
        mimeType: "application/pdf",
        sizeBytes: binary.bytes.length,
        version: binary.version,
      },
      modelContent: [],
    };
    if (input.capabilities.pdf) {
      result.modelContent = [
        {
          type: "file",
          source_type: "base64",
          mime_type: "application/pdf",
          data: base64,
        },
      ];
      return result;
    }
    if (input.capabilities.image)
      return await rasterPages(
        document,
        binary,
        limits,
        start,
        range.end,
        result,
        input.signal,
      );
    let characters = limits.codeReadPageCharacters;
    let extractedText = "";
    const maxPage = Math.min(range.end, start + limits.codePdfMaxPages - 1);
    for (let number = start; number <= maxPage; number += 1) {
      input.signal?.throwIfAborted();
      const page = await document.getPage(number);
      try {
        const text = await page.getTextContent();
        const full = text.items
          .flatMap((item) => ("str" in item ? [item.str] : []))
          .join(" ");
        const character =
          number === start ? (input.pdfContinuation?.character ?? 0) : 0;
        if (!Number.isSafeInteger(character) || character < 0)
          throw new Error("PDF 字符继续指针无效");
        const points = Array.from(full);
        if (character > points.length)
          throw new Error("PDF 字符继续指针超过本页长度");
        const visible = points
          .slice(character, character + characters)
          .join("");
        extractedText += `${number}\t${visible}\n`;
        characters -= Array.from(visible).length;
        if (character + Array.from(visible).length < points.length) {
          result.pdfContinuation = {
            page: number,
            character: character + Array.from(visible).length,
            version: binary.version,
          };
          break;
        }
        if (number < range.end && (characters === 0 || number === maxPage)) {
          result.pdfContinuation = {
            page: number + 1,
            character: 0,
            version: binary.version,
          };
          break;
        }
      } finally {
        page.cleanup();
      }
    }
    if (!extractedText.replace(/^\d+\t/gm, "").trim())
      throw new Error(
        "PDF 没有可提取文字；当前模型需要支持原生 PDF 或图片页才能读取扫描内容",
      );
    result.extractedText = extractedText;
    result.truncated = result.pdfContinuation !== undefined;
    result.modelContent = [
      {
        type: "text",
        text: `PDF ${binary.path}（${document.numPages} 页）\n${extractedText}${result.pdfContinuation ? `\n继续读取：${JSON.stringify(result.pdfContinuation)}` : ""}`,
      },
    ];
    return result;
  } catch (error) {
    input.signal?.throwIfAborted();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    await (destroying ?? document.destroy());
  }
}
