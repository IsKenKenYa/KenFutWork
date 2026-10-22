import { watch } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { mediaDriverPreviewResponseSchema } from "@kenfutwork/shared";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerMediaDriverRoutes } from "../../http/media-drivers.js";
import { createCommitResponseLossProxy } from "../code-ui/pg-commit-response-loss.fixture.mjs";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import type { PersistenceService } from "../persistence/types.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createMediaDriverRepository } from "./repository.js";
import { createMediaDriverService } from "./service.js";

const source = `
export const manifest = {
  apiVersion: 1, id: "registry-example", version: "1.0.0", name: "安装验证",
  origins: ["https://media.example.com"],
  models: [{ id: "native-picture", name: "图片", capability: "image", execution: "sync" }]
};
throw new Error("安装不能执行文件");
export async function submit() {
  return { state: "succeeded", outputs: [{ kind: "image", url: "https://media.example.com/result.png", mimeType: "image/png" }] };
}
`;

async function createRegistryHttp(
  db: Awaited<ReturnType<typeof createTaskWorkDatabase>>,
  persistence: PersistenceService = db.persistence,
) {
  const app = Fastify();
  const headers = { authorization: `Bearer ${db.desktopToken}` };
  const settings = createSettingsService({
    repository: createSettingsRepository(db.persistence),
    localInstance: db.localInstance,
  });
  const service = () =>
    createMediaDriverService({
      localInstance: db.localInstance,
      settings,
      repository: createMediaDriverRepository(persistence),
    });
  await registerMediaDriverRoutes(app, {
    localAccess: db.localAccess,
    mediaDrivers: service(),
  });
  return {
    app,
    service,
    async preview(text = source) {
      const result = await app.inject({
        method: "POST",
        url: "/api/media-drivers/preview",
        headers,
        payload: { source: text },
      });
      expect(result.statusCode, result.body).toBe(200);
      const preview = mediaDriverPreviewResponseSchema.parse(result.json());
      return {
        source: text,
        sourceDigest: preview.sourceDigest,
        compiledDigest: preview.compiledDigest,
        expectedGeneration: 0,
        expectedRevision: 0,
        approvedOrigins: ["https://media.example.com"],
      };
    },
    install: (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/media-drivers",
        headers,
        payload,
      }),
    versions: () =>
      app.inject({
        method: "GET",
        url: "/api/media-drivers/registry-example/versions",
        headers,
      }),
    source: (versionId: string) =>
      app.inject({
        method: "GET",
        headers,
        url: `/api/media-drivers/registry-example/versions/${versionId}/source`,
      }),
  };
}

const pgTest = it.skipIf(process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1");

pgTest("确认访问地址后安装，公开版本接口读取原始文件", async () => {
  const db = await createTaskWorkDatabase();
  const http = await createRegistryHttp(db);
  try {
    expect(db.replayed).toContain("20261022135618");
    expect(db.secondReplay).toEqual([]);
    const payload = await http.preview();
    const installed = await http.install(payload);
    expect(installed.statusCode, installed.body).toBe(201);
    const driver = installed.json().driver;
    expect(driver.id).toBe("registry-example");
    expect(driver.generation).toBe(1);
    expect(driver.revision).toBe(1);
    const versions = await http.versions();
    expect(versions.statusCode, versions.body).toBe(200);
    expect(
      versions.json().versions.map((item: { id: string }) => item.id),
    ).toEqual([driver.currentVersion.id]);
    const saved = await http.source(driver.currentVersion.id);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().source).toBe(source);
    expect(saved.json().sourceDigest).toBe(payload.sourceDigest);
    const invalid = await http.app.inject({
      method: "POST",
      url: "/api/media-drivers/preview",
      headers: { authorization: `Bearer ${db.desktopToken}` },
      payload: { source: source.replace("registry-example", "a".repeat(300)) },
    });
    expect(invalid.statusCode).toBe(400);
    await http.service().recover();
    await rm(
      join(
        db.directory,
        "media-drivers",
        "versions",
        driver.id,
        driver.currentVersion.id,
        "source.ts",
      ),
    );
    const missing = await http.source(driver.currentVersion.id);
    expect(missing.statusCode, missing.body).toBe(503);
    expect(missing.json().error.code).toBe("media_driver_storage_error");
    expect(missing.body).not.toContain(db.directory);
  } finally {
    await http.app.close();
    await db.close();
  }
});

pgTest("并发安装和恢复保持唯一版本", async () => {
  const db = await createTaskWorkDatabase();
  const http = await createRegistryHttp(db);
  const failures: unknown[] = [];
  const recovering: Promise<unknown>[] = [];
  const pending = join(db.directory, "media-drivers", "pending");
  await mkdir(pending, { recursive: true });
  const watcher = watch(pending, () => {
    recovering.push(
      http
        .service()
        .recover()
        .catch((error) => {
          failures.push(error);
        }),
    );
  });
  try {
    const payload = await http.preview();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => http.install(payload)),
    );
    expect(results.map((result) => result.statusCode)).toEqual(
      Array(8).fill(201),
    );
    const ids = results.map((result) => result.json().driver.currentVersion.id);
    expect(new Set(ids).size).toBe(1);
    expect(results.filter((result) => !result.json().replayed)).toHaveLength(1);
    await Promise.all(recovering);
    expect(failures).toEqual([]);
    await http.service().recover();
    const versions = await http.versions();
    expect(versions.json().versions).toHaveLength(1);
    const saved = await http.source(ids[0]);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().source).toBe(source);
    const conflict = await http.install(
      await http.preview(`${source}\n// 修改`),
    );
    expect(conflict.statusCode, conflict.body).toBe(409);
    const denied = await http.app.inject({
      method: "POST",
      url: "/api/media-drivers",
      payload,
    });
    expect(denied.statusCode).toBe(401);
    const unapproved = await http.install({
      ...payload,
      approvedOrigins: ["https://other.example.com"],
    });
    expect(unapproved.statusCode).toBe(400);
    expect(unapproved.json().error.code).toBe("media_driver_permissions");
  } finally {
    watcher.close();
    await Promise.all(recovering);
    await http.app.close();
    await db.close();
  }
});

pgTest("提交回包丢失后恢复原文件并重放同一版本", async () => {
  const db = await createTaskWorkDatabase();
  const proxy = await createCommitResponseLossProxy(db.connectionString);
  const persistence = createPostgresPersistence({
    databaseUrl: proxy.connectionString,
  });
  const http = await createRegistryHttp(db, persistence);
  try {
    const payload = await http.preview();
    proxy.arm("registry-example", {
      mediaInstall: true,
      blackoutAfterCommit: true,
    });
    const uncertain = await http.install(payload);
    expect(uncertain.statusCode).toBe(500);
    expect(proxy.evidence().injected).toMatchObject({
      commitConfirmed: true,
      replySuppressed: true,
    });
    expect(proxy.evidence().observerError).toBeUndefined();
    proxy.restore();
    await http.service().recover();
    const replay = await http.install(payload);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().replayed).toBe(true);
    const versionId = replay.json().driver.currentVersion.id;
    const saved = await http.source(versionId);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().source).toBe(source);
    const versions = await http.versions();
    expect(
      versions.json().versions.map((item: { id: string }) => item.id),
    ).toEqual([versionId]);
  } finally {
    proxy.restore();
    await http.app.close();
    await persistence.close();
    await proxy.close();
    await db.close();
  }
});
