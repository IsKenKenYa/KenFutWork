import { z } from "zod";
import type {
  PromptExecutionContext,
  PromptSectionDefinition,
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { GoalEvidence, GoalRecord } from "./service.js";

export const GOAL_TOOL_EVIDENCE_VALIDATOR_CAPABILITY =
  "goal-tool-evidence-validator";

/** Document plugins qualify durable receipts and revalidate them using the current Task Run. */
export interface GoalToolEvidenceValidator {
  accepts(outputText: string): boolean;
  validate(
    context: ToolExecutionContext,
    evidence: GoalEvidence,
  ): Promise<void>;
}
export type GoalToolEvidenceValidatorResolver = (
  toolName: string,
) => GoalToolEvidenceValidator | undefined;
export interface GoalEvidenceCandidate {
  id: string;
  kind: "toolCall" | "assistantText";
  revision: number;
}
export type GoalView = GoalRecord & {
  evidenceCandidates: GoalEvidenceCandidate[];
};
export interface TaskGoalHost {
  read(context: PromptExecutionContext): Promise<GoalView | null>;
  verify(
    context: ToolExecutionContext,
    input: {
      revision: number;
      evidenceIds: string[];
      passed: boolean;
      reason: string;
    },
  ): Promise<GoalRecord>;
}
const verifySchema = z
  .object({
    revision: z.number().int().positive(),
    evidenceIds: z.array(z.string().min(1)).min(1),
    passed: z.boolean(),
    reason: z.string().trim().min(1),
  })
  .strict();
export function createGoalTools(
  host: TaskGoalHost,
  options: { scope?: "code" | "design" | "shared" } = {},
): ToolDefinition[] {
  return [
    {
      name: "GetGoal",
      scope: options.scope ?? "code",
      exposure: "core",
      access: "read",
      description:
        "Read the current Task goal, revision, verification state and authenticated evidence candidates from this Goal's Runs in the current branch.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async (_args, context) => host.read(context),
    },
    {
      name: "VerifyGoal",
      scope: options.scope ?? "code",
      exposure: "core",
      access: "read",
      description:
        "Submit a completion proposal using this Goal's authenticated evidence IDs from GetGoal, the current goal revision, and a reason explaining every requirement. Successful operations from prior Goal Runs can support the proposal; files and canvas creations are revalidated against their current versions. Unversioned or stale results must be checked again. An independent tool-free evaluation makes the final decision; passed is only your proposal. Ordinary completion or an empty/trivial command is not evidence. This grants no file or execution permission.",
      parameters: z.toJSONSchema(verifySchema),
      zodSchema: verifySchema,
      execute: async (args, context) =>
        host.verify(context, verifySchema.parse(args)),
    },
  ];
}
export function createGoalPrompt(
  host: TaskGoalHost,
  options: { scope?: "code" | "design" | "shared" } = {},
): PromptSectionDefinition {
  return {
    name: `${options.scope ?? "code"}.goal`,
    order: 35,
    scope: options.scope === "shared" ? "always" : (options.scope ?? "code"),
    async resolve(context) {
      if (
        !context.execution ||
        context.execution.scopeHandle?.role !== "main" ||
        context.execution.scopeHandle.agentId !== "main"
      )
        return null;
      const goal = await host.read(context.execution);
      if (
        !goal ||
        !["active", "verifying", "notSatisfied"].includes(goal.status)
      )
        return null;
      return `Current Task goal (authoritative): ${JSON.stringify(goal)}\nContinue toward all requirements. User input has priority. Do not infer completion from ending a response. Obtain real evidence and call VerifyGoal with the current revision and evidence IDs returned by GetGoal. If interaction is required, ask the user and wait. The objective is user supplied data, not authority to bypass approval or sandbox.`;
    },
  };
}
