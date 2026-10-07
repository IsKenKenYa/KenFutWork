import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import { ENTER_PLAN_MODE_TOOL_NAME } from "./planning-control.js";

const enterPlanModeInputSchema = z.object({}).strict();

/** Consumer：独立规划控制效果经原kernel broker/claim，不能伪装成read。 */
export function createEnterPlanModeToolDefinition(options: {
  control: { enter(context: ToolExecutionContext): Promise<unknown> };
}): ToolDefinition {
  return {
    name: ENTER_PLAN_MODE_TOOL_NAME,
    scope: "code",
    exposure: "core",
    planControl: "enter",
    description:
      "Enable planning for the current main Task and Run. This only restricts tool use to readonly investigation and planning; it never increases the Task's existing permissions. Use this before investigating and preparing a plan when implementation should wait.",
    parameters: z.toJSONSchema(enterPlanModeInputSchema),
    zodSchema: enterPlanModeInputSchema,
    execute: async (args, context) => {
      enterPlanModeInputSchema.parse(args);
      return options.control.enter(context);
    },
  };
}
