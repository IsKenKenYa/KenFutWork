import { pendingInteractionSchema } from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it } from "vitest";
import type { ApprovalEvent, PermissionInvocation } from "./approval-types.js";
import { createPermissionService } from "./permission-service.js";

function pendingFor(service: ReturnType<typeof createPermissionService>) {
  const pending = service.listPending("workspace", "task")[0];
  if (!pending) throw new Error("测试操作应生成一个等待人审的真实请求。");
  return pending;
}

function invocation(
  patch: Partial<PermissionInvocation> = {},
): PermissionInvocation {
  return {
    preset: "code",
    workspaceId: "workspace",
    taskId: "task",
    runId: "run",
    toolCallId: "call",
    userId: "user",
    agentId: "main",
    role: "main",
    scopeGeneration: 1,
    branchGeneration: 1,
    mode: "build",
    approvalCeiling: "build",
    toolName: "Write",
    args: { file_path: "main.ts", content: "export {};" },
    access: "write",
    ...patch,
  };
}

function binding(input: PermissionInvocation) {
  return {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    runId: input.runId,
    userId: input.userId,
    scopeGeneration: input.scopeGeneration,
    branchGeneration: input.branchGeneration,
  };
}

describe("Code 逐调用审批公共服务", () => {
  it("审批展示隐藏环境值，批准仍绑定完整原始参数，换Key不能借同一展示重放", async () => {
    const service = createPermissionService();
    const input = invocation({ toolName: "install_mcp_server", access: "execute", args: { name: "server", env: { TASK_SECRET: "private-value" } }, displayArgs: { name: "server", envKeys: ["TASK_SECRET"] } });
    const admitted = service.admit(input);
    const pending = pendingFor(service);
    expect(pending.interaction.payload).toMatchObject({ detail: { name: "server", envKeys: ["TASK_SECRET"] } });
    expect(JSON.stringify(pending)).not.toContain("private-value");
    await service.resolve({ interactionId: pending.interaction.interactionId, binding: binding(input), answer: { optionId: "allowOnce" } });
    expect((await admitted).decision).toBe("allow");
    expect(service.peek({ ...input, args: { name: "server", env: { TASK_SECRET: "different-value" } } }).decision).toBe("deny");
    expect(service.claim(input).decision).toBe("allow");
  });
  it("edit仅自动受控FS编辑，应用/配置write仍逐调用等待人审", async () => {
    const service = createPermissionService();
    for (const toolName of ["Write", "Edit", "ApplyPatch"]) {
      expect(
        service.peek(invocation({ mode: "edit", toolName, access: "write" }))
          .decision,
        toolName,
      ).toBe("allow");
    }
    const input = invocation({
      mode: "edit",
      toolName: "create_skill",
      access: "write",
      args: { name: "review", content: "manifest" },
    });
    const admitted = service.admit(input);
    try {
      expect(service.listPending("workspace", "task")).toHaveLength(1);
    } finally {
      await service.cancel(
        { workspaceId: "workspace", taskId: "task" },
        "Task 结束",
      );
    }
    expect((await admitted).decision).toBe("deny");
    expect(
      service.peek(
        invocation({
          mode: "edit",
          toolName: "create_mcp_server",
          access: "write",
        }),
      ).decision,
    ).toBe("deny");
  });

  it("批准后 Task 撤销，再次 admit 返回当前拒绝而非历史放行", async () => {
    const service = createPermissionService();
    const input = invocation();
    const admitted = service.admit(input);
    const pending = pendingFor(service);
    await service.resolve({
      interactionId: pending.interaction.interactionId,
      binding: binding(input),
      answer: { action: "accept" },
    });
    expect((await admitted).decision).toBe("allow");
    await service.cancel(
      { workspaceId: "workspace", taskId: "task" },
      "目录授权已撤销",
    );
    expect((await service.admit(input)).decision).toBe("deny");
  });

  it("不同 agent 的同名工具调用身份独立，不因同 run/toolCallId 互相碰撞", async () => {
    const service = createPermissionService();
    const main = service.admit(invocation());
    const child = service.admit(
      invocation({ agentId: "worker-one", role: "worker" }),
    );
    try {
      expect(service.listPending("workspace", "task")).toHaveLength(2);
    } finally {
      await service.cancel(
        { workspaceId: "workspace", taskId: "task" },
        "Task 关闭",
      );
    }
    expect((await main).decision).toBe("deny");
    expect((await child).decision).toBe("deny");
  });

  it("回执不能改写审批参数，也不能用相互矛盾的 action/optionId 授权", async () => {
    const service = createPermissionService();
    const input = invocation();
    const admitted = service.admit(input);
    const pending = pendingFor(service);
    for (const answer of [
      { action: "accept" as const, optionId: "deny" },
      {
        action: "accept" as const,
        content: { modifiedInput: { file_path: "other.ts" } },
      },
    ]) {
      expect(
        await service.resolve({
          interactionId: pending.interaction.interactionId,
          binding: binding(input),
          answer,
        }),
      ).toMatchObject({
        status: "rejected",
        reasonCode: "approval.invalidAnswer",
      });
    }
    await service.cancel(
      { workspaceId: "workspace", taskId: "task" },
      "Task 关闭",
    );
    expect((await admitted).decision).toBe("deny");
  });

  it.each(["accept", "decline", "cancel"] as const)(
    "V4 原 action=%s 回执遵守同一个真实调用绑定",
    async (action) => {
      const service = createPermissionService();
      const input = invocation();
      const admitted = service.admit(input);
      const pending = pendingFor(service);
      const expected = action === "accept" ? "allow" : "deny";
      expect(
        await service.resolve({
          interactionId: pending.interaction.interactionId,
          binding: binding(input),
          answer: { action },
        }),
      ).toMatchObject({ status: "resolved", decision: expected });
      expect((await admitted).decision).toBe(expected);
    },
  );

  it.each(["requested", "resolved"] as const)(
    "%s 事件持久化失败即拒绝，并结束等待",
    async (failedType) => {
      const service = createPermissionService();
      const input = invocation();
      service.onEvent((event) => {
        if (event.type === failedType) throw new Error("持久化失败");
      });
      const admitted = service.admit(input);
      if (failedType === "resolved") {
        const pending = pendingFor(service);
        expect(
          await service.resolve({
            interactionId: pending.interaction.interactionId,
            binding: binding(input),
            answer: { optionId: "allowOnce" },
          }),
        ).toMatchObject({ status: "resolved", decision: "deny" });
      }
      expect((await admitted).decision).toBe("deny");
      expect(service.listPending("workspace", "task")).toEqual([]);
      expect(service.claim(input).decision).toBe("deny");
    },
  );

  it("自动放行也在最终入口消费，重复调用不能再执行", () => {
    const service = createPermissionService();
    const input = invocation({ mode: "edit" });
    expect(service.claim(input).decision).toBe("allow");
    expect(service.claim(input).decision).toBe("deny");
  });

  it("同键请求去重；规范化参数顺序等价，参数和执行身份改变不能借用批准", async () => {
    const service = createPermissionService();
    const input = invocation();
    const events: ApprovalEvent[] = [];
    service.onEvent((event) => {
      events.push(event);
    });
    const admitted = service.admit(input);
    const second = service.admit({
      ...input,
      args: { content: "export {};", file_path: "main.ts" },
    });
    const pending = pendingFor(service);
    expect(events.map((event) => event.type)).toEqual(["requested"]);
    expect(
      (
        await service.admit({
          ...input,
          args: { ...input.args, content: "changed" },
        })
      ).decision,
    ).toBe("deny");
    await service.resolve({
      interactionId: pending.interaction.interactionId,
      binding: binding(input),
      answer: { optionId: "allowOnce" },
    });
    expect((await admitted).decision).toBe("allow");
    expect((await second).decision).toBe("allow");
    for (const patch of [
      { agentId: "other" },
      { userId: "other" },
      { toolName: "Edit" },
      { scopeGeneration: 2 },
      { branchGeneration: 2 },
    ]) {
      expect(service.peek({ ...input, ...patch }).decision).toBe("deny");
    }
    expect(service.peek({ ...input, mode: "plan" }).decision).toBe("deny");
    expect(events.map((event) => event.type)).toEqual([
      "requested",
      "resolved",
    ]);
  });

  it("跨用户、Task、Run、scope 与 branch 回执拒绝；先到响应获胜", async () => {
    const service = createPermissionService();
    const input = invocation();
    const admitted = service.admit(input);
    const pending = pendingFor(service);
    for (const patch of [
      { userId: "other" },
      { workspaceId: "other" },
      { taskId: "other" },
      { runId: "other" },
      { scopeGeneration: 2 },
      { branchGeneration: 2 },
    ]) {
      expect(
        await service.resolve({
          interactionId: pending.interaction.interactionId,
          binding: { ...binding(input), ...patch },
          answer: { optionId: "allowOnce" },
        }),
      ).toMatchObject({
        status: "rejected",
        reasonCode: "approval.invalidBinding",
      });
    }
    expect(
      await service.resolve({
        interactionId: pending.interaction.interactionId,
        binding: binding(input),
        answer: { optionId: "deny", freeText: "不要覆盖此文件" },
      }),
    ).toEqual({ status: "resolved", decision: "deny" });
    expect((await admitted).reason).toBe("不要覆盖此文件");
    expect(
      await service.resolve({
        interactionId: pending.interaction.interactionId,
        binding: binding(input),
        answer: { optionId: "allowOnce" },
      }),
    ).toEqual({
      status: "alreadyResolved",
      reasonCode: "proto.alreadyResolved",
    });
    expect(service.claim(input).decision).toBe("deny");
  });

  it("main plan 的可信只读 Bash 仍逐调用 ask；审批不能写文件", async () => {
    const service = createPermissionService();
    const input = invocation({
      mode: "plan",
      toolName: "Bash",
      access: "execute",
      readonlyExecution: true,
    });
    const admitted = service.admit(input);
    const pending = pendingFor(service);
    expect(pending.interaction.payload).toMatchObject({ toolName: "Bash" });
    await service.resolve({
      interactionId: pending.interaction.interactionId,
      binding: binding(input),
      answer: { optionId: "allowOnce" },
    });
    expect((await admitted).decision).toBe("allow");
    expect(service.claim({ ...input, readonlyExecution: false }).decision).toBe(
      "deny",
    );
    expect(service.claim(input).decision).toBe("allow");
  });

  it("不完整的人审绑定不能通过只比较客户端提供字段来放行", async () => {
    const service = createPermissionService();
    const input = invocation();
    const admitted = service.admit(input);
    const pending = pendingFor(service);
    expect(
      await service.resolve({
        interactionId: pending.interaction.interactionId,
        answer: { optionId: "allowOnce" },
        binding: JSON.parse("{}"),
      }),
    ).toEqual({ status: "rejected", reasonCode: "approval.invalidBinding" });
    await service.cancel(
      { workspaceId: "workspace", taskId: "task" },
      "Task 关闭",
    );
    expect((await admitted).decision).toBe("deny");
  });

  it("Run 停止取消审批等待，迟到批准不能执行", async () => {
    const service = createPermissionService();
    const controller = new AbortController();
    const input = invocation({ signal: controller.signal });
    const admitted = service.admit(input);
    const pending = pendingFor(service);
    controller.abort();
    expect(service.listPending("workspace", "task")).toEqual([]);
    expect((await admitted).decision).toBe("deny");
    expect(
      await service.resolve({
        interactionId: pending.interaction.interactionId,
        binding: binding(input),
        answer: { optionId: "allowOnce" },
      }),
    ).toMatchObject({ status: "alreadyResolved" });
    expect(service.claim(input).decision).toBe("deny");
  });

  it("worker 保留派发时审批上限，父 Task 改成 yolo 不自动放大旧 worker", () => {
    const service = createPermissionService();
    expect(
      service.peek(
        invocation({ role: "worker", mode: "yolo", approvalCeiling: "build" }),
      ).decision,
    ).toBe("deny");
    expect(
      service.peek(
        invocation({ role: "worker", mode: "yolo", approvalCeiling: "plan" }),
      ).reason,
    ).toMatch(/不能扩权/);
    expect(
      service.peek(
        invocation({ role: "worker", mode: "build", approvalCeiling: "yolo" }),
      ).decision,
    ).toBe("deny");
    expect(
      service.peek(
        invocation({ role: "worker", mode: "yolo", approvalCeiling: "edit" }),
      ).decision,
    ).toBe("allow");
    expect(
      service.peek(
        invocation({
          role: "worker",
          mode: "yolo",
          approvalCeiling: "edit",
          toolName: "Bash",
          access: "execute",
        }),
      ).decision,
    ).toBe("deny");
  });

  it("只读角色与 plan 写入直接拒绝，不能生成扩权审批", async () => {
    for (const input of [
      invocation({ role: "explore", mode: "yolo" }),
      invocation({
        role: "review",
        mode: "yolo",
        toolName: "Bash",
        access: "execute",
        readonlyExecution: true,
      }),
      invocation({ mode: "plan" }),
      invocation({ mode: "plan", toolName: "Bash", access: "execute" }),
      invocation({ mode: "yolo", access: undefined }),
    ]) {
      const service = createPermissionService();
      const admitted = service.admit(input);
      expect(service.listPending("workspace", "task")).toEqual([]);
      expect((await admitted).decision).toBe("deny");
    }
  });

  it("Task 自动编辑与 yolo 按本地模式放行，不借用全局权限档", () => {
    const service = createPermissionService();
    expect(service.peek(invocation({ mode: "edit" })).decision).toBe("allow");
    expect(
      service.peek(
        invocation({ mode: "yolo", toolName: "Bash", access: "execute" }),
      ).decision,
    ).toBe("allow");
    service.setTier(undefined, "full-access");
    expect(service.peek(invocation({ mode: "build" })).decision).toBe("deny");
    expect(
      service.peek(
        invocation({ mode: "edit", toolName: "Bash", access: "execute" }),
      ).decision,
    ).toBe("deny");
  });

  it("V4 本次批准唤醒原调用，peek 不消费，最终 claim 只能执行一次", async () => {
    const service = createPermissionService();
    const input = invocation();
    const admitted = service.admit(input);
    const pending = pendingFor(service);
    expect(
      pendingInteractionSchema.parse(pending?.interaction).payload,
    ).toMatchObject({
      kind: "permission",
      toolName: "Write",
      toolCallId: "call",
      options: [
        { optionId: "allowOnce", kind: "allowOnce" },
        { optionId: "deny", kind: "deny" },
      ],
    });
    expect(service.peek(input).decision).toBe("deny");
    expect(
      await service.resolve({
        interactionId: pending.interaction.interactionId,
        binding: binding(input),
        answer: { optionId: "allowOnce" },
      }),
    ).toEqual({ status: "resolved", decision: "allow" });
    expect((await admitted).decision).toBe("allow");
    expect(service.peek(input).decision).toBe("allow");
    expect(service.peek(input).decision).toBe("allow");
    expect(service.claim(input).decision).toBe("allow");
    expect(service.claim(input).decision).toBe("deny");
  });
});
