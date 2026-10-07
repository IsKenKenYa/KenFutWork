import { describe, expect, it } from "vitest";
import type { PermissionInvocation } from "../permissions/approval-types.js";
import { createPermissionService } from "../permissions/permission-service.js";

const PLAN = "# 用户可见的完整计划\n\n只有明确批准才退出规划。\n";
function invocation(): PermissionInvocation {
  return {
    preset: "code",
    instanceId: "owner",
    taskId: "task",
    runId: "run",
    toolCallId: "exit",
    agentId: "main",
    role: "main",
    scopeGeneration: 1,
    branchGeneration: 1,
    planningEpoch: 3,
    mode: "yolo",
    approvalCeiling: "yolo",
    toolName: "ExitPlanMode",
    planControl: "exit",
    access: undefined,
    args: { plan: PLAN },
  };
}

describe("原逐调用broker的明确计划批准", () => {
  it("yolo也等待，显式不完整answers不得被兼容字段补回；正确答案只消费一次", async () => {
    const service = createPermissionService();
    const input = invocation();
    const admitted = service.admit(input);
    const pending = service.listPending("owner", "task")[0];
    if (pending?.interaction.payload.kind !== "userInput")
      throw new Error("缺少真实计划批准交互。");
    const payload = pending.interaction.payload;
    expect(payload).toMatchObject({
      input: { plan: PLAN },
      schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
    });
    const question = payload.questions?.[0]?.question;
    if (!question) throw new Error("缺少真实批准题文。");
    const binding = { ...pending.identity };
    for (const content of [
      {},
      { answers: {}, answer_0: "approve", answer: "approve" },
      { answers: { wrong: "approve" }, answer_0: "approve" },
      { answers: { [question]: "approve" }, answer: "reject" },
    ]) {
      expect(
        await service.resolve({
          interactionId: pending.interaction.interactionId,
          binding,
          answer: { action: "accept", content },
        }),
      ).toMatchObject({ status: "rejected" });
      expect(service.listPending("owner", "task")).toHaveLength(1);
      expect(service.peek(input).decision).toBe("deny");
    }
    expect(
      await service.resolve({
        interactionId: pending.interaction.interactionId,
        binding: { ...binding, planningEpoch: 5 },
        answer: {
          action: "accept",
          content: { answers: { [question]: "approve" } },
        },
      }),
    ).toMatchObject({
      status: "rejected",
      reasonCode: "approval.invalidBinding",
    });
    expect(
      await service.resolve({
        interactionId: pending.interaction.interactionId,
        binding,
        answer: {
          action: "accept",
          content: {
            answers: { [question]: "approve" },
            answer_0: "approve",
            answer: "approve",
          },
        },
      }),
    ).toMatchObject({ status: "resolved", decision: "allow" });
    expect((await admitted).decision).toBe("allow");
    expect(service.peek({ ...input, planningEpoch: 5 }).decision).toBe("deny");
    expect(
      service.peek({ ...input, args: { plan: "另一个计划" } }).decision,
    ).toBe("deny");
    expect(service.claim(input).decision).toBe("allow");
    expect(service.claim(input).decision).toBe("deny");
  });
});
