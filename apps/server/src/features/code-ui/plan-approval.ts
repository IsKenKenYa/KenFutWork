import { randomUUID } from "node:crypto";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import type {
  ApprovalResolution,
  BoundApprovalRequest,
  PermissionInvocation,
} from "../permissions/approval-types.js";

export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";
const QUESTION = "批准以下实施计划并退出规划？";

/** 原Elicitation合同；完整正文仍在原工具input可见，不拿Todo冒充批准。 */
export function createPlanApprovalRequest(
  input: PermissionInvocation,
  identity: BoundApprovalRequest["identity"],
): BoundApprovalRequest {
  if (
    input.toolName !== EXIT_PLAN_MODE_TOOL_NAME ||
    typeof input.args.plan !== "string" ||
    !input.args.plan.trim() ||
    !Number.isSafeInteger(identity.planningEpoch)
  )
    throw new Error("计划批准缺少可信正文或规划代际。");
  return {
    identity,
    parameterFingerprint: parameterFingerprint(input.args),
    interaction: {
      interactionId: randomUUID(),
      kind: "userInput",
      anchorRowId: null,
      createdAt: Date.now(),
      payload: {
        kind: "userInput",
        prompt: input.args.plan,
        freeText: false,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        traceId: input.runId,
        input: { plan: input.args.plan },
        schema: {
          interaction: "plan_approval",
          toolName: EXIT_PLAN_MODE_TOOL_NAME,
        },
        questions: [
          {
            question: QUESTION,
            header: "批准计划",
            multiSelect: false,
            options: [
              {
                label: "批准计划并继续",
                value: "approve",
                description: "按该计划继续当前任务，保留原有权限。",
              },
              {
                label: "继续规划",
                value: "reject",
                description: "保持规划开启，继续完善计划。",
              },
            ],
          },
        ],
      },
    },
  };
}

/** 只接受实际选项值；空accept、自由文本、普通permission记忆均不能签发批准。 */
export function planApprovalDecision(
  answer: ApprovalResolution["answer"],
): "allow" | "deny" | undefined {
  if (answer.action === "decline" || answer.action === "cancel") return "deny";
  if (
    answer.action !== "accept" ||
    answer.optionId !== undefined ||
    answer.freeText !== undefined
  )
    return undefined;
  const content = answer.content;
  if (!content || typeof content !== "object" || Array.isArray(content))
    return undefined;
  const answers = content.answers;
  if (
    answers !== undefined &&
    (!answers || typeof answers !== "object" || Array.isArray(answers))
  )
    return undefined;
  if (
    Object.hasOwn(content, "answers") &&
    (!answers || !Object.hasOwn(answers, QUESTION))
  )
    return undefined;
  const values = [
    answers === undefined
      ? undefined
      : (answers as Record<string, unknown>)[QUESTION],
    content.answer_0,
    content.answer,
  ].filter((value) => value !== undefined);
  if (!values.length || values.some((value) => value !== values[0]))
    return undefined;
  return values[0] === "approve"
    ? "allow"
    : values[0] === "reject"
      ? "deny"
      : undefined;
}
