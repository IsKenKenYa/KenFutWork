/**
 * zcode 照搬（P2 补充）：`@zcode/shared/zcode-protocol-v4` 子路径的消费切片 barrel。
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：上游为 index.ts 全量 `export *`；此处只 barrel 本仓 zcode 照搬件实际消费的
 * 符号面（toolResultDisplay / execute renderer / fileSummaryTypes / v4 conversationCuaGroups
 * / toolCallRowAdapter / conversationTurnFlowItems），成员文件逐字照搬见同目录。
 */

import { z } from "zod";

export {
  type ModelSelection,
  modelSelectionSchema,
} from "../../zcode-shared";
export { bashOutputDisplaySchema } from "./bash-output-display";
export * from "./core";
export {
  type ToolCallCreateWorkflowDisplay,
  toolCallCreateWorkflowDisplaySchema,
} from "./create-workflow-display";
export * from "./cuaPermission";
export {
  type ExecutionOutputPreview,
  executionOutputPreviewSchema,
} from "./execution-output-preview";
export * from "./rows";
export {
  type ToolCallEvalWorkflowSnippetDisplay,
  type ToolCallGetWorkflowRunDisplay,
  type ToolCallListModelsDisplay,
  type ToolCallListWorkflowRunsDisplay,
  type ToolCallResumeWorkflowRunDisplay,
  type ToolCallSavedWorkflowListDisplay,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
} from "./workflow-observation-display";
export type { WorkflowRunState } from "./workflow-runs";

/* ---------- snapshot.ts 的 errorAttribution 切片（P5 补充，照搬声明） ----------
 * 来源：references/zcode/packages/shared/src/zcode-protocol-v4/snapshot.ts
 * 消费方：lib/zcodeUiError.ts（ZCodeError → errorAttributionSchema.parse）。 */

export const errorAttributionSchema = z
  .object({
    source: z.enum(["provider", "runtime", "tool", "network"]).optional(),
    reason: z.string().min(1).max(160).optional(),
    errorPhase: z
      .enum([
        "prepare",
        "configuration",
        "connect",
        "response",
        "stream",
        "parse",
        "validation",
        "unhandled",
      ])
      .optional(),
    exceptionKind: z
      .enum([
        "api_call",
        "generic",
        "protocol",
        "provider_business",
        "transport",
        "type_error",
        "validation",
      ])
      .optional(),
    providerId: z.string().min(1).max(160).optional(),
    modelId: z.string().min(1).max(160).optional(),
    providerKind: z.string().min(1).max(160).optional(),
    transport: z.enum(["http", "sse", "websocket"]).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    providerErrorCode: z.string().min(1).max(160).optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
export type ErrorAttribution = z.infer<typeof errorAttributionSchema>;
