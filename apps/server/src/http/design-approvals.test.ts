import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../features/code-ui/plan-approval.js";
import { createDesignApprovalsService } from "../features/execution/design-approvals.js";
import type { DesignTaskPolicy } from "../features/execution/design-task-types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import type { PermissionInvocation } from "../features/permissions/approval-types.js";
import { createPermissionService } from "../features/permissions/permission-service.js";
import { registerDesignApprovalRoutes } from "./design-approvals.js";

async function fixture(plan = false) {
  const actor: LocalActor = {
    instanceId: randomUUID(),
    accessClientId: randomUUID(),
  };
  const taskId = randomUUID();
  const policy: DesignTaskPolicy = {
    taskId,
    projectId: randomUUID(),
    canvasId: randomUUID(),
    rootDirectory: "/owned",
    additionalDirectories: [],
    sandboxMode: "workspace-write",
    scopeGeneration: 2,
    branchGeneration: 3,
    mode: "build",
    planEnabled: plan,
    planningEpoch: 4,
    activeRunId: randomUUID(),
    executionState: "ready",
  };
  const permissions = createPermissionService();
  const approvals = createDesignApprovalsService({
    permissions,
    designTasks: {
      readPolicy: async (user, requested) => {
        if (user.instanceId !== actor.instanceId || requested !== taskId)
          throw new Error("wrong actual Task binding");
        return structuredClone(policy);
      },
    },
  });
  const app = Fastify();
  await registerDesignApprovalRoutes(app, {
    localAccess: { authenticate: async () => actor },
    approvals,
  });
  const start = (override: Partial<PermissionInvocation> = {}) => {
    const invocation: PermissionInvocation = {
      preset: "design",
      instanceId: actor.instanceId,
      taskId,
      runId: policy.activeRunId ?? "",
      toolCallId: randomUUID(),
      agentId: "main",
      role: "main",
      scopeGeneration: policy.scopeGeneration,
      branchGeneration: policy.branchGeneration,
      mode: plan ? "plan" : "build",
      approvalCeiling: "build",
      toolName: plan ? EXIT_PLAN_MODE_TOOL_NAME : "Write",
      access: plan ? undefined : "write",
      args: plan
        ? { plan: "actual implementation plan" }
        : { content: "owned mutation" },
      ...(plan
        ? { planControl: "exit", planningEpoch: policy.planningEpoch }
        : {}),
      ...override,
    };
    const completion = permissions.admit(invocation);
    const pending = permissions
      .listPending(actor.instanceId, invocation.taskId)
      .find((request) => request.identity.toolCallId === invocation.toolCallId);
    if (!pending)
      throw new Error("real admission did not create a pending interaction");
    return { invocation, pending, completion };
  };
  return {
    actor,
    taskId,
    policy,
    permissions,
    app,
    start,
    url: (interactionId: string) =>
      `/api/design-tasks/${taskId}/approvals/${interactionId}/resolve`,
    close: async () => {
      await permissions.cancel(
        { instanceId: actor.instanceId, taskId },
        "fixture ended",
      );
      await app.close();
    },
  };
}

it.each(["allowOnce", "deny"] as const)(
  "Design HTTP resolves actual %s approval exactly once",
  async (optionId) => {
    const f = await fixture();
    try {
      const call = f.start();
      const list = await f.app.inject({
        method: "GET",
        url: `/api/design-tasks/${f.taskId}/approvals`,
      });
      expect(list.statusCode).toBe(200);
      expect(
        list
          .json()
          .approvals.map(
            (item: { interactionId: string }) => item.interactionId,
          ),
      ).toEqual([call.pending.interaction.interactionId]);
      const result = await f.app.inject({
        method: "POST",
        url: f.url(call.pending.interaction.interactionId),
        payload: { answer: { optionId } },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({
        status: "resolved",
        decision: optionId === "allowOnce" ? "allow" : "deny",
      });
      expect((await call.completion).decision).toBe(
        optionId === "allowOnce" ? "allow" : "deny",
      );
      const repeated = await f.app.inject({
        method: "POST",
        url: f.url(call.pending.interaction.interactionId),
        payload: { answer: { optionId } },
      });
      expect(repeated.json().status).toBe("alreadyResolved");
      const firstClaim = f.permissions.claim(call.invocation);
      expect(firstClaim.decision).toBe(
        optionId === "allowOnce" ? "allow" : "deny",
      );
      expect(f.permissions.claim(call.invocation).decision).toBe("deny");
    } finally {
      await f.close();
    }
  },
);

it("real canonical plan approval is listed and resolved with its actual question answer", async () => {
  const f = await fixture(true);
  try {
    const call = f.start();
    const payload = call.pending.interaction.payload;
    if (payload.kind !== "userInput")
      throw new Error("actual plan approval missing");
    const question = payload.questions?.[0]?.question;
    if (!question) throw new Error("canonical question missing");
    const list = await f.app.inject({
      method: "GET",
      url: `/api/design-tasks/${f.taskId}/approvals`,
    });
    expect(list.json().approvals[0].kind).toBe("userInput");
    const invalid = await f.app.inject({
      method: "POST",
      url: f.url(call.pending.interaction.interactionId),
      payload: { answer: { action: "accept" } },
    });
    expect(invalid.statusCode).toBe(400);
    const result = await f.app.inject({
      method: "POST",
      url: f.url(call.pending.interaction.interactionId),
      payload: {
        answer: {
          action: "accept",
          content: { answers: { [question]: "approve" } },
        },
      },
    });
    expect(result.statusCode).toBe(200);
    expect((await call.completion).decision).toBe("allow");
  } finally {
    await f.close();
  }
});

it.each(["run", "scope", "branch", "planning", "unready"])(
  "rejects stale %s authority from server Task facts",
  async (changed) => {
    const f = await fixture(true);
    try {
      const call = f.start();
      if (changed === "run") f.policy.activeRunId = randomUUID();
      if (changed === "scope") f.policy.scopeGeneration++;
      if (changed === "branch") f.policy.branchGeneration++;
      if (changed === "planning") f.policy.planningEpoch++;
      if (changed === "unready") f.policy.executionState = "revoking";
      const list = await f.app.inject({
        method: "GET",
        url: `/api/design-tasks/${f.taskId}/approvals`,
      });
      expect(list.json().approvals).toEqual([]);
      const result = await f.app.inject({
        method: "POST",
        url: f.url(call.pending.interaction.interactionId),
        payload: { answer: { action: "decline" } },
      });
      expect(result.statusCode).toBe(409);
      expect(
        f.permissions.listPending(f.actor.instanceId, f.taskId),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

it("isolates other Task pending requests, rejects client binding and cannot resurrect cancellation", async () => {
  const f = await fixture();
  try {
    const call = f.start();
    const other = f.start({ taskId: randomUUID() });
    const isolated = await f.app.inject({
      method: "POST",
      url: f.url(other.pending.interaction.interactionId),
      payload: { answer: { optionId: "allowOnce" } },
    });
    expect(isolated.statusCode).toBe(404);
    const forged = await f.app.inject({
      method: "POST",
      url: f.url(call.pending.interaction.interactionId),
      payload: {
        answer: { optionId: "allowOnce" },
        binding: { runId: f.policy.activeRunId, scopeGeneration: 2 },
      },
    });
    expect(forged.statusCode).toBe(400);
    await f.permissions.cancel(
      { instanceId: f.actor.instanceId, taskId: f.taskId },
      "stopped",
    );
    expect((await call.completion).decision).toBe("deny");
    const cancelled = await f.app.inject({
      method: "POST",
      url: f.url(call.pending.interaction.interactionId),
      payload: { answer: { optionId: "allowOnce" } },
    });
    expect(cancelled.json().status).toBe("alreadyResolved");
    expect(f.permissions.claim(call.invocation).decision).toBe("deny");
    await f.permissions.cancel(
      { instanceId: f.actor.instanceId, taskId: other.invocation.taskId },
      "fixture ended",
    );
    expect((await other.completion).decision).toBe("deny");
  } finally {
    await f.close();
  }
});
