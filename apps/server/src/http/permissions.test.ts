import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createPermissionService } from "../features/permissions/permission-service.js";
import { registerPermissionRoutes } from "./permissions.js";

describe("权限 HTTP 公共入口", () => {
  it("未绑定 once 返回 400；旧永久策略不改变 Task-local Code 审批", async () => {
    const app = Fastify();
    const permissions = createPermissionService();
    await registerPermissionRoutes(app, {
      auth: {
        authenticate: async () => ({
          id: "user",
          email: "user@example.test",
          accessToken: "test",
          userMetadata: {},
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
          args: { file_path: "test.ts", content: "test" },
          access: "write",
        }).decision,
      ).toBe("deny");
    } finally {
      await app.close();
    }
  });
});
