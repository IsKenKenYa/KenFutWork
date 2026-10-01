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
