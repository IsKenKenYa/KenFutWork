/**
 * zcode 照搬（P6 补充）：`@zcode/shared` zcode-protocol-v4/shared-context-ref.ts
 * （references/zcode/packages/shared/src/zcode-protocol-v4/shared-context-ref.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
import { z } from "zod";

export const sharedContextRefSchema = z
  .object({
    kind: z.literal("shared_context_import"),
    context_id: z.string().trim().min(1),
  })
  .strict();

export type SharedContextRef = z.infer<typeof sharedContextRefSchema>;
