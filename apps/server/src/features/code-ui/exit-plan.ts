import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import { EXIT_PLAN_MODE_TOOL_NAME } from "./plan-approval.js";

const exitPlanModeInputSchema = z
  .object({
    plan: z
      .string()
      .refine((value) => value.trim().length > 0, "计划正文不能为空"),
  })
  .strict();

export function createExitPlanModeToolDefinition(options: {
  control: { exit(context: ToolExecutionContext): Promise<unknown> };
}): ToolDefinition {
  return {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    scope: "code",
    exposure: "core",
    planControl: "exit",
    description:
      "Present a complete Markdown implementation plan to the user and wait for explicit approval. Only approval saves the managed plan and disables planning for the current main Task and Run. This does not increase Task permissions or select a file path.",
    parameters: z.toJSONSchema(exitPlanModeInputSchema),
    zodSchema: exitPlanModeInputSchema,
    execute: async (args, context) => {
      exitPlanModeInputSchema.parse(args);
      return options.control.exit(context);
    },
  };
}
