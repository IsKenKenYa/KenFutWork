import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerMediaDriverRoutes } from "../../http/media-drivers.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createMediaDriverService } from "./service.js";

it.skipIf(process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1")(
  "预览 HTTP 验证本机授权并读取数据库中的文件大小设置",
  async () => {
    const db = await createTaskWorkDatabase();
    const app = Fastify();
    try {
      const settings = createSettingsService({
        repository: createSettingsRepository(db.persistence),
        localInstance: db.localInstance,
      });
      const mediaDrivers = createMediaDriverService({
        localInstance: db.localInstance,
        settings,
      });
      await registerMediaDriverRoutes(app, {
        localAccess: db.localAccess,
        mediaDrivers,
      });
      const payload = {
        source: `
        export const manifest = {
          apiVersion: 1, id: "http-media", version: "1", name: "HTTP测试",
          origins: ["https://example.com"],
          models: [{ id: "picture", name: "图片", capability: "image", execution: "sync" }]
        };
        export async function submit() { return { state: "succeeded", outputs: [] }; }
      `,
      };
      const headers = { authorization: `Bearer ${db.desktopToken}` };
      const denied = await app.inject({
        method: "POST",
        url: "/api/media-drivers/preview",
        payload,
      });
      expect(denied.statusCode).toBe(401);
      const response = await app.inject({
        method: "POST",
        url: "/api/media-drivers/preview",
        headers,
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().manifest.models[0].id).toBe("picture");
      expect(response.json().validation).toBe("format_only");
      expect(response.json()).not.toHaveProperty("compiledCode");
      await settings.updateInstanceSettings(db.actor, db.instanceId, {
        mediaDriverMaxSourceBytes: 1024,
      });
      const tooLarge = await app.inject({
        method: "POST",
        url: "/api/media-drivers/preview",
        headers,
        payload: { source: `${payload.source}/*${"汉".repeat(400)}*/` },
      });
      expect(tooLarge.statusCode, tooLarge.body).toBe(400);
      expect(tooLarge.json().error.code).toBe("media_driver_invalid_file");
    } finally {
      await app.close();
      await db.close();
    }
  },
);
