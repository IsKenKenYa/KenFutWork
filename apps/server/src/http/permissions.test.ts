import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createPermissionService } from "../features/permissions/permission-service.js";
import { registerPermissionRoutes } from "./permissions.js";

describe("权限 HTTP 公共入口", () => {
  it("未绑定 once 返回 400；旧永久策略不改变 Task-local Code 审批", async () => {
    const app = Fastify();
    const permissions = createPermissionService();
    await registerPermissionRoutes(app, {
      localAccess: {
        authenticate: async () => ({
          instanceId: "00000000-0000-4000-8000-000000000001",
          accessClientId: "00000000-0000-4000-8000-000000000009",
        }),
      },
      permissions,
    });
    try {
      const once = await app.inject({
        method: "POST",
        url: "/api/permissions/approve",
        payload: { toolName: "Write", scope: "once" },
      });
      expect(once.statusCode).toBe(400);
      expect(once.json()).toMatchObject({
        error: {
          code: "invalid_request",
          message: expect.stringContaining("绑定"),
        },
      });
      const forever = await app.inject({
        method: "POST",
        url: "/api/permissions/approve",
        payload: { toolName: "Write", scope: "forever" },
      });
      expect(forever.statusCode).toBe(204);
      expect(permissions.evaluate({ toolName: "Write" }).decision).toBe(
        "allow",
      );
      expect(
        permissions.peek({
          preset: "code",
          instanceId: "00000000-0000-4000-8000-000000000001",
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
          args: { file_path: "test.ts", content: "test" },
          access: "write",
        }).decision,
      ).toBe("deny");
    } finally {
      await app.close();
    }
  });
});
