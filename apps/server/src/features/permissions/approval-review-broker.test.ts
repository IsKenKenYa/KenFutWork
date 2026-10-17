import { afterEach, expect, it, vi } from "vitest";
import type {
  ApprovalReviewer,
  ApprovalReviewGrant,
  PermissionInvocation,
} from "./approval-types.js";
import { createCodeApprovalService } from "./code-approval.js";

const input = (
  patch: Partial<PermissionInvocation> = {},
): PermissionInvocation => ({
  preset: "code",
  instanceId: "instance",
  taskId: "task",
  runId: "run",
  toolCallId: "call",
  agentId: "main",
  role: "main",
  scopeGeneration: 1,
  branchGeneration: 1,
  mode: "build",
  approvalCeiling: "build",
  toolName: "Write",
  access: "write",
  args: { file_path: "note.md", content: "hello" },
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Reviewer = ApprovalReviewer;
function allowGrant(): ApprovalReviewGrant {
  const controller = new AbortController();
  return {
    decision: "allow",
    signal: controller.signal,
    validate: async () => !controller.signal.aborted,
    release: () => controller.abort(),
  };
}
const services: ReturnType<typeof createCodeApprovalService>[] = [];
function fixture(review: Reviewer) {
  const service = createCodeApprovalService({ review });
  services.push(service);
  return service;
}
afterEach(async () => {
  await Promise.all(
    services
      .splice(0)
      .map((service) =>
        service.cancel(
          { instanceId: "instance", taskId: "task" },
          "test cleanup",
        ),
      ),
  );
});

it("模型仅在 requested 全部持久化后启动，沿原 broker 结算且 claim 只消费一次", async () => {
  const publishing = deferred<void>();
  const review = vi.fn<Reviewer>(async () => allowGrant());
  const service = fixture(review);
  const events: string[] = [];
  service.onEvent(async (event) => {
    if (event.type === "requested") await publishing.promise;
    events.push(event.type);
  });
  const admitted = service.admit(input());
  const duplicate = service.admit(input());
  expect(review).not.toHaveBeenCalled();
  expect(service.listPending("instance", "task")).toHaveLength(1);
  publishing.resolve();
  await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1), {
    timeout: 500,
  });
  expect(await admitted).toEqual({ decision: "allow" });
  expect(await duplicate).toEqual({ decision: "allow" });
  expect(events).toEqual(["requested", "resolved"]);
  expect(service.listPending("instance", "task")).toEqual([]);
  expect(service.claim(input()).decision).toBe("allow");
  expect(service.claim(input()).decision).toBe("deny");
  expect(
    service.claim(input({ args: { file_path: "other.md", content: "hello" } }))
      .decision,
  ).toBe("deny");
});

it.each(["manual", "error"] as const)(
  "审查%s保留同一人工请求，不重复审查或伪造拒绝",
  async (result) => {
    const review = vi.fn<Reviewer>(async () => {
      if (result === "error") throw new Error("private upstream failure");
      return "manual";
    });
    const service = fixture(review);
    const admitted = service.admit(input());
    const request = service.listPending("instance", "task")[0]!;
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1), {
      timeout: 500,
    });
    expect(
      service.listPending("instance", "task")[0]?.interaction.interactionId,
    ).toBe(request.interaction.interactionId);
    expect(service.peek(input()).decision).toBe("deny");
    await service.resolve({
      interactionId: request.interaction.interactionId,
      binding: request.identity,
      answer: { optionId: "allowOnce" },
    });
    expect(await admitted).toEqual({ decision: "allow" });
    expect(review).toHaveBeenCalledTimes(1);
  },
);

it.each(["human", "stop", "revoke"] as const)(
  "%s先到时取消审查，迟到 allow 不覆盖原结算",
  async (winner) => {
    const decision = deferred<ApprovalReviewGrant | "manual">();
    const review = vi.fn<Reviewer>(() => decision.promise);
    const controller = new AbortController();
    const invocation = input({ signal: controller.signal });
    const service = fixture(review);
    const admitted = service.admit(invocation);
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1), {
      timeout: 500,
    });
    const request = service.listPending("instance", "task")[0]!;
    const signal = review.mock.calls[0]![1];
    if (winner === "human")
      await service.resolve({
        interactionId: request.interaction.interactionId,
        binding: request.identity,
        answer: { optionId: "deny" },
      });
    else if (winner === "stop") controller.abort();
    else
      await service.cancel(
        { instanceId: "instance", taskId: "task", scopeGeneration: 1 },
        "授权已撤销",
      );
    expect((await admitted).decision).toBe("deny");
    expect(signal.aborted).toBe(true);
    decision.resolve(allowGrant());
    await Promise.resolve();
    await Promise.resolve();
    expect(service.claim(invocation).decision).toBe("deny");
    expect(service.listPending("instance", "task")).toEqual([]);
  },
);

it("完全访问直接执行，角色deny和退出规划不调用模型", async () => {
  const review = vi.fn<Reviewer>(async () => allowGrant());
  const service = fixture(review);
  expect(
    await service.admit(input({ mode: "yolo", approvalCeiling: "yolo" })),
  ).toEqual({ decision: "allow" });
  expect((await service.admit(input({ role: "review" }))).decision).toBe(
    "deny",
  );
  const planned = input({
    toolCallId: "exit",
    toolName: "ExitPlanMode",
    access: undefined,
    mode: "plan",
    planControl: "exit",
    planningEpoch: 1,
    args: { plan: "写入并验证订单汇总" },
  });
  const pending = service.admit(planned);
  await service.cancel(
    { instanceId: "instance", taskId: "task" },
    "规划需人工批准",
  );
  expect((await pending).decision).toBe("deny");
  expect(review).not.toHaveBeenCalled();
});

it("模型allow等待持久化期间配置撤销不能变成可消费授权", async () => {
  const publishing = deferred<void>();
  const grant = allowGrant();
  const review = vi.fn<Reviewer>(async () => grant);
  const service = fixture(review);
  const resolved = vi.fn();
  service.onEvent(async (event) => {
    if (event.type === "resolved") {
      resolved();
      await publishing.promise;
    }
  });
  const admitted = service.admit(input());
  await vi.waitFor(() => expect(resolved).toHaveBeenCalledTimes(1));
  grant.release();
  publishing.resolve();
  expect((await admitted).decision).toBe("deny");
  expect(service.claim(input()).decision).toBe("deny");
});

it("模型已回答但尚未claim时重验用户要求，失效批准不落到执行体", async () => {
  const grant = allowGrant();
  const service = fixture(async () => grant);
  expect((await service.admit(input())).decision).toBe("allow");
  grant.validate = async () => false;
  expect((await service.revalidate(input())).decision).toBe("deny");
  expect(service.claim(input()).decision).toBe("deny");
});
