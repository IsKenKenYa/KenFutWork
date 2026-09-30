/**
 * zcode 照搬：`@zcode/shared` zcode-media-policy.ts（references/zcode/packages/shared/src/zcode-media-policy.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
/** ZCode 接受单个 video 输入的全局原始字节上限。 */
export const VIDEO_INPUT_MAX_BYTES = 30 * 1024 * 1024;

export const MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE =
  "MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE";
export const MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE =
  "MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE";

export const MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE =
  "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE";
