/**
 * zcode 照搬：`@zcode/shared` execution-output-preview.ts（references/zcode/packages/shared/src/execution-output-preview.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
import { z } from "zod";

const OUTPUT_PREVIEW_MAX_CHARACTERS = 4096;
/** 两端共用的 Bash 有界输出内容；不包含 replayable 传输恢复状态。 */
export const executionOutputPreviewSchema = z
  .object({
    text: z.string().max(OUTPUT_PREVIEW_MAX_CHARACTERS),
    fullText: z.string().max(OUTPUT_PREVIEW_MAX_CHARACTERS),
    totalLines: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    linesEstimated: z.boolean(),
  })
  .strict();
export type ExecutionOutputPreview = z.infer<
  typeof executionOutputPreviewSchema
>;
