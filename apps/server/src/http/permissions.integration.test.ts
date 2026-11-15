import { applicationErrorResponseSchema } from "@kenfutwork/shared";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { createPermissionService } from "../features/permissions/permission-service.js";
import { createPermissionSettingsStore } from "../features/permissions/tier-store.js";
import { createTaskWorkDatabase } from "../features/task-work/test-postgres-schema.js";
import { registerPermissionRoutes } from "./permissions.js";

it.skipIf(process.env.KENFUTWORK_SETTINGS_TEST_PG !== "1")(
  "权限配置写入失败时向调用方说明哪些变更生效",
  async () => {
    const db = await createTaskWorkDatabase();
    const app = Fastify();
    const tierStore = createPermissionSettingsStore(db.persistence);
    const permissions = createPermissionService();
    const headers = { authorization: `Bearer ${db.desktopToken}` };
    const tierRequest = {
      method: "PUT",
      url: "/api/permissions/tier",
      headers,
      payload: { automationTier: "auto-approve" },
    } as const;
    const approveRequest = {
      method: "POST",
      url: "/api/permissions/approve",
      headers,
      payload: { toolName: "Write", scope: "forever" },
    } as const;
    try {
      await registerPermissionRoutes(app, {
        localAccess: db.localAccess,
        permissions,
        tierStore,
      });
      await db.persistence.execute(
        "alter table public.app_config rename to permission_error_probe",
      );

      const tierFailure = await app.inject(tierRequest);
      expect(tierFailure.statusCode).toBe(500);
      expect(applicationErrorResponseSchema.parse(tierFailure.json())).toEqual({
        error: {
          code: "settings_failed",
          message: "权限设置未保存，原设置仍有效，请稍后再试。",
        },
      });
      expect(permissions.getSettings().automationTier).toBe("default");

      const approveFailure = await app.inject(approveRequest);
      expect(approveFailure.statusCode).toBe(500);
      expect(
        applicationErrorResponseSchema.parse(approveFailure.json()),
      ).toEqual({
        error: {
          code: "settings_failed",
          message: "永久批准未保存，当前仍有效，请稍后再试。",
        },
      });
      expect(permissions.listApprovedForever()).toEqual(["Write"]);

      await db.persistence.execute(
        "alter table public.permission_error_probe rename to app_config",
      );
      expect(await tierStore.load()).toMatchObject({
        automationTier: "default",
        approvedForever: [],
      });
      expect((await app.inject(approveRequest)).statusCode).toBe(204);
      expect((await app.inject(tierRequest)).statusCode).toBe(200);
      expect(await tierStore.load()).toMatchObject({
        automationTier: "auto-approve",
        approvedForever: ["Write"],
      });
    } finally {
      await app.close();
      await db.close();
    }
  },
  30_000,
);
