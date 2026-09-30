/**
 * zcode 照搬（P6 补充）：`@zcode/shared` zcode-protocol-v4/submission.ts
 * （references/zcode/packages/shared/src/zcode-protocol-v4/submission.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
import { z } from "zod";

/** Composer 可以显式提交的 Agent mode；auto 是 Runtime 内部状态，不进入用户 Submission。 */
export const submissionModeSchema = z.enum(["build", "edit", "plan", "yolo"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
