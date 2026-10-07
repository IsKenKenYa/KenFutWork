import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";

/**
 * 截图预算与黑帧检测（Computer Use 插件）。
 *
 * 黑帧检测是 macOS 执行层的**强制护栏**（实测教训）：nut-js 在进程无屏幕录制
 * 权限时**不抛错而是静默返回全黑图**，且 `getAuthStatus` 与实际捕获能力可能
 * 不一致——所以捕获质量只能靠内容判定，不能信权限查询单边结论。
 */

/** 采样点数上限：黑帧判定不需要读完全部像素。 */
const MAX_SAMPLES = 4096;

/** 逐点判定全黑占比（0~1）；空数据按全黑计（fail closed）。 */
export function blackFrameRatio(rgb: Uint8Array): number {
  if (rgb.length < 3) return 1;
  const step = Math.max(3, Math.floor(rgb.length / MAX_SAMPLES / 3) * 3);
  let sampled = 0;
  let black = 0;
  for (let i = 0; i + 2 < rgb.length; i += step) {
    sampled += 1;
    if (rgb[i] === 0 && rgb[i + 1] === 0 && rgb[i + 2] === 0) {
      black += 1;
    }
  }
  return sampled === 0 ? 1 : black / sampled;
}

/** 全黑占比超过该阈值即判黑帧。 */
const BLACK_FRAME_THRESHOLD = 0.995;

export function isBlackFrame(rgb: Uint8Array): boolean {
  return blackFrameRatio(rgb) >= BLACK_FRAME_THRESHOLD;
}

export type ImageInlinePlan =
  | { inline: true }
  | { inline: false; reason: string };

/**
 * 截图是否以内联 base64 进工具结果（UI 的 CuaScreenshotSection 深度识别
 * `{mimeType,data}` / data URI）。超预算**拒绝内联**并说明原因——不截断图片
 * 硬塞（截断的 base64 两头都不认）。
 */
export function planImageInline(input: {
  base64Length: number;
  /** 治理键注入（computerUseScreenshotMaxBytes），禁止调用方写字面量。 */
  maxInlineBytes: number;
}): ImageInlinePlan {
  if (input.base64Length <= input.maxInlineBytes) {
    return { inline: true };
  }
  return {
    inline: false,
    reason: `截图 base64 长度 ${input.base64Length} 超出内联预算 ${input.maxInlineBytes}（可在设置里调 computerUseScreenshotMaxBytes）。本次仅返回文字摘要。`,
  };
}

/** PNG声明尺寸先过实例资源预算；Adam7路径也先做有界inflate，避免库的无界分支。 */
export function readPngWithinBudget(bytes: Buffer, maxBytes: number) {
  const invalid = () =>
    Object.assign(new Error("截图不是完整、合法的PNG"), {
      code: "image_invalid",
      actionSent: false,
    });
  if (
    bytes.length < 33 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw invalid();
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height) throw invalid();
  if (bytes.length > maxBytes || width * height * 4 > maxBytes)
    throw Object.assign(
      new Error("截图解码超出当前processMaxOutputBytes设置，请调整实例设置"),
      { code: "image_budget_exceeded", actionSent: false },
    );
  if (bytes[28] === 1) {
    const parts: Buffer[] = [];
    let offset = 8;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) throw invalid();
      const length = bytes.readUInt32BE(offset),
        end = offset + length + 12;
      if (end > bytes.length) throw invalid();
      if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT")
        parts.push(bytes.subarray(offset + 8, end - 4));
      offset = end;
    }
    try {
      inflateSync(Buffer.concat(parts), { maxOutputLength: maxBytes });
    } catch {
      throw invalid();
    }
  }
  try {
    return PNG.sync.read(bytes, { checkCRC: true });
  } catch {
    throw invalid();
  }
}
