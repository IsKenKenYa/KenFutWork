import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  mediaDriverPreviewResponseSchema,
} from "@kenfutwork/shared";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerMediaDriverRoutes } from "../../http/media-drivers.js";
import { createCommitResponseLossProxy } from "../code-ui/pg-commit-response-loss.fixture.mjs";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGenerationTargets } from "../generation/file-targets.js";
import { createJobService } from "../jobs/job-service.js";
import { createJobRepository } from "../jobs/repository.js";
import { createModelProviderService } from "../model-providers/model-provider-service.js";
import { createModelProviderRepository } from "../model-providers/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import type { PersistenceService } from "../persistence/types.js";
import { createInProcessQueue } from "../queue/providers/in-process.js";
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
        installationId: result.json().installation?.installationId,
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
    update: (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/media-drivers/registry-example/versions",
        headers,
        payload,
      }),
    setEnabled: (payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: "/api/media-drivers/registry-example",
        headers,
        payload,
      }),
    remove: (payload: Record<string, unknown>) =>
      app.inject({
        method: "DELETE",
        url: "/api/media-drivers/registry-example",
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

async function createConnectionHttp(
  db: Awaited<ReturnType<typeof createTaskWorkDatabase>>,
  connectionFields: string,
  secrets: { [key: string]: string },
  persistence: PersistenceService = db.persistence,
) {
  const http = await createRegistryHttp(db, persistence);
  const providers = createModelProviderService({
    localInstance: db.localInstance,
    repository: createModelProviderRepository(db.persistence),
  });
  const provider = await providers.createInstance(db.actor, {
    name: "媒体连接",
    protocol: "openai-compatible",
    apiKey: "chat-only-key",
    models: [{ id: "native-chat", name: "聊天", capability: "chat" }],
  });
  const file = source.replace(
    'origins: ["https://media.example.com"],',
    `origins: ["https://media.example.com"], connectionFields: ${connectionFields},`,
  );
  const preview = await http.preview(file);
  const installed = await http.install(preview);
  expect(installed.statusCode, installed.body).toBe(201);
  const url = `/api/media-drivers/registry-example/connections/${provider.id}`;
  const headers = { authorization: `Bearer ${db.desktopToken}` };
  const payload = {
    installationId: preview.installationId,
    expectedGeneration: 1,
    expectedRevision: 1,
    expectedConnectionRevision: 0,
    values: {},
    secrets,
    credentialOrigins: ["https://media.example.com"],
  };
  return {
    ...http,
    providers,
    provider,
    preview,
    payload,
    save: (changes: object = {}) =>
      http.app.inject({
        method: "PUT",
        url,
        headers,
        payload: { ...payload, ...changes },
      }),
    read: () => http.app.inject({ method: "GET", url, headers }),
    credentials: (authorized = true) =>
      http.app.inject({
        method: "GET",
        url: `${url}/credentials`,
        ...(authorized ? { headers } : {}),
      }),
  };
}

pgTest("自定义连接保存普通字段和秘密字段，普通读取不包含凭据", async () => {
  const db = await createTaskWorkDatabase();
  const http = await createConnectionHttp(
    db,
    `[
      { key: "region", label: "地区", default: "cn" },
      { key: "toString", label: "名称", default: "自定义名称" },
      { key: "apiKey", label: "API Key", secret: true, required: true }
    ]`,
    { apiKey: "media-secret-only" },
  );
  try {
    const saved = await http.save();
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().connection).toMatchObject({
      providerId: http.provider.id,
      installationId: http.preview.installationId,
      revision: 1,
      values: { region: "cn", toString: "自定义名称" },
      secretKeys: ["apiKey"],
      credentialOrigins: ["https://media.example.com"],
    });
    expect(saved.body).not.toContain("media-secret-only");
    const read = await http.read();
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().connection).toEqual(saved.json().connection);
    expect(read.body).not.toContain("media-secret-only");
    const credentials = await http.credentials();
    expect(credentials.statusCode, credentials.body).toBe(200);
    expect(credentials.json()).toEqual({
      secrets: { apiKey: "media-secret-only" },
    });
    expect(credentials.headers["cache-control"]).toBe("no-store");
    expect((await http.credentials(false)).statusCode).toBe(401);
    expect(
      await http.providers.readCredential(db.actor, http.provider.id),
    ).toBe("chat-only-key");
    expect(
      await http
        .service()
        .connection(db.actor, "registry-example", http.provider.id),
    ).toEqual(read.json());
  } finally {
    await http.app.close();
    await db.close();
  }
});

pgTest("连接校验、并发重放、版本保留和卸载清理", async () => {
  const db = await createTaskWorkDatabase();
  const http = await createConnectionHttp(
    db,
    `[
      { key: "region", label: "地区", default: "cn" },
      { key: "token", label: "Token", secret: true }
    ]`,
    { token: "original-connection-key" },
  );
  try {
    for (const changed of [
      { values: { token: "wrong-place" } },
      { values: { extra: "unknown" } },
      { secrets: { region: "wrong-place" } },
      { credentialOrigins: ["https://unapproved.example.com"] },
    ])
      expect((await http.save(changed)).statusCode).toBe(400);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => http.save()),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(
      Array(8).fill(200),
    );
    expect(
      responses.filter((response) => !response.json().replayed),
    ).toHaveLength(1);
    const first = responses[0]?.json().connection;
    if (!first) throw new Error("连接没有返回保存结果");
    expect(
      new Set(responses.map((response) => response.json().connection.id)).size,
    ).toBe(1);
    const conflict = await http.save({ secrets: { token: "changed-key" } });
    expect(conflict.statusCode, conflict.body).toBe(409);
    const updated = await http.save({
      expectedConnectionRevision: 1,
      values: { region: "us" },
      secrets: {},
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().connection).toMatchObject({
      revision: 2,
      values: { region: "us" },
      secretKeys: ["token"],
    });
    expect((await http.credentials()).json()).toEqual({
      secrets: { token: "original-connection-key" },
    });
    const cleared = await http.save({
      expectedConnectionRevision: 2,
      secrets: { token: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().connection).toMatchObject({
      revision: 3,
      values: { region: "us" },
      secretKeys: [],
    });
    expect((await http.credentials()).json()).toEqual({ secrets: {} });
    expect((await http.save()).json()).toEqual({
      connection: first,
      replayed: true,
    });
    const removed = await http.remove({
      installationId: http.preview.installationId,
      expectedGeneration: 1,
      expectedRevision: 1,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await http.save()).statusCode).toBe(410);
    expect((await http.read()).json()).toEqual({ connection: null });
    await expect(
      readFile(
        join(
          db.directory,
          "credentials",
          "media-drivers",
          first.id,
          "fields.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await http.app.close();
    await db.close();
  }
});

pgTest.each([false, true])(
  "连接事务回包丢失后恢复凭据（回滚=%s）",
  async (rollback) => {
    const db = await createTaskWorkDatabase();
    const proxy = await createCommitResponseLossProxy(db.connectionString);
    const persistence = createPostgresPersistence({
      databaseUrl: proxy.connectionString,
    });
    const http = await createConnectionHttp(
      db,
      '[{ key: "token", label: "Token", secret: true, required: true }]',
      { token: "cold-media-secret" },
      persistence,
    );
    try {
      proxy.arm(http.provider.id, {
        mediaInstall: true,
        blackoutAfterCommit: !rollback,
        rollbackBeforeCommit: rollback,
      });
      const uncertain = await http.save();
      expect(uncertain.statusCode).toBe(500);
      expect(proxy.evidence().injected).toMatchObject({
        commitConfirmed: !rollback,
        replySuppressed: true,
      });
      expect(proxy.evidence().observerError).toBeUndefined();
      proxy.restore();
      await http.service().recover();
      const replay = await http.save();
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().replayed).toBe(!rollback);
      expect(
        await http
          .service()
          .connectionCredentials(
            db.actor,
            "registry-example",
            http.provider.id,
          ),
      ).toEqual({ secrets: { token: "cold-media-secret" } });
    } finally {
      proxy.restore();
      await http.app.close();
      await persistence.close();
      await proxy.close();
      await db.close();
    }
  },
);

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

pgTest("更新预览列出模型变化，更新后仍可读取旧文件", async () => {
  const db = await createTaskWorkDatabase();
  const http = await createRegistryHttp(db);
  try {
    const installed = await http.install(await http.preview());
    const previous = installed.json().driver;
    const changed = source.replace("native-picture", "new-picture");
    const preview = await http.app.inject({
      method: "POST",
      url: "/api/media-drivers/preview",
      headers: { authorization: `Bearer ${db.desktopToken}` },
      payload: { source: changed },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().changes).toMatchObject({
      addedModels: ["new-picture"],
      removedModels: ["native-picture"],
      changedModels: [],
    });
    const payload = {
      ...(await http.preview(changed)),
      expectedGeneration: previous.generation,
      expectedRevision: previous.revision,
    };
    const updated = await http.update(payload);
    expect(updated.statusCode, updated.body).toBe(201);
    expect(updated.json().driver.revision).toBe(2);
    expect(updated.json().driver.generation).toBe(1);
    const oldFile = await http.source(previous.currentVersion.id);
    expect(oldFile.json().source).toBe(source);
    const newFile = await http.source(updated.json().driver.currentVersion.id);
    expect(newFile.json().source).toBe(changed);
    const replay = await http.update(payload);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().driver).toEqual(updated.json().driver);
    const conflict = await http.update({
      ...(await http.preview(`${changed}\n// 修改`)),
      expectedGeneration: 1,
      expectedRevision: 1,
    });
    expect(conflict.statusCode).toBe(409);
  } finally {
    await http.app.close();
    await db.close();
  }
});

pgTest("并发更新只保存一个新版本，重复请求复用原回执", async () => {
  const db = await createTaskWorkDatabase();
  const http = await createRegistryHttp(db);
  try {
    await http.install(await http.preview());
    const candidates = await Promise.all([
      http.preview(source.replace("native-picture", "first-picture")),
      http.preview(source.replace("native-picture", "second-picture")),
    ]);
    const payloads = candidates.map((candidate) => ({
      ...candidate,
      expectedGeneration: 1,
      expectedRevision: 1,
    }));
    const responses = await Promise.all(payloads.map(http.update));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    const winnerIndex = responses.findIndex(
      (response) => response.statusCode === 201,
    );
    const receipt = responses[winnerIndex]?.json();
    const winner = payloads[winnerIndex];
    if (!winner || !receipt) throw new Error("更新未返回唯一成功回执");
    const replays = await Promise.all(
      Array.from({ length: 8 }, () => http.update(winner)),
    );
    expect(
      replays.every(
        (response) =>
          response.statusCode === 201 && response.json().replayed === true,
      ),
    ).toBe(true);
    const versions = await http.versions();
    expect(
      versions
        .json()
        .versions.map((version: { revision: number }) => version.revision),
    ).toEqual([2, 1]);
    expect(versions.json().versions[0].id).toBe(
      receipt.driver.currentVersion.id,
    );
  } finally {
    await http.app.close();
    await db.close();
  }
});

pgTest("更新提交回包丢失后冷恢复保留两个版本", async () => {
  const db = await createTaskWorkDatabase();
  const proxy = await createCommitResponseLossProxy(db.connectionString);
  const persistence = createPostgresPersistence({
    databaseUrl: proxy.connectionString,
  });
  const http = await createRegistryHttp(db, persistence);
  try {
    const previous = await http.install(await http.preview());
    const changed = source.replace("native-picture", "updated-picture");
    const payload = {
      ...(await http.preview(changed)),
      expectedGeneration: 1,
      expectedRevision: 1,
    };
    proxy.arm("registry-example", {
      mediaInstall: true,
      blackoutAfterCommit: true,
    });
    const uncertain = await http.update(payload);
    expect(uncertain.statusCode).toBe(500);
    expect(proxy.evidence().injected).toMatchObject({
      commitConfirmed: true,
      replySuppressed: true,
    });
    expect(proxy.evidence().observerError).toBeUndefined();
    proxy.restore();
    await http.service().recover();
    const replay = await http.update(payload);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().replayed).toBe(true);
    const current = await http.source(replay.json().driver.currentVersion.id);
    expect(current.json().source).toBe(changed);
    const original = await http.source(
      previous.json().driver.currentVersion.id,
    );
    expect(original.json().source).toBe(source);
    expect((await http.versions()).json().versions).toHaveLength(2);
  } finally {
    proxy.restore();
    await http.app.close();
    await persistence.close();
    await proxy.close();
    await db.close();
  }
});

pgTest("停用卸载后旧请求不能重新安装，新预览使用新内部ID", async () => {
  const db = await createTaskWorkDatabase();
  const http = await createRegistryHttp(db);
  try {
    const install = await http.preview();
    expect(
      await db.persistence.queryOne("show unix_socket_directories"),
    ).toEqual({ unix_socket_directories: "" });
    expect(install.installationId).toEqual(expect.any(String));
    const created = await http.install(install);
    expect(created.statusCode, created.body).toBe(201);
    const identity = {
      installationId: install.installationId,
      expectedGeneration: 1,
      expectedRevision: 1,
    };
    const disabled = await http.setEnabled({ ...identity, enabled: false });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().driver.enabled).toBe(false);
    expect(disabled.json().driver.revision).toBe(2);
    const disabledReplay = await http.setEnabled({
      ...identity,
      enabled: false,
    });
    expect(disabledReplay.json().replayed).toBe(true);
    expect(
      (await http.setEnabled({ ...identity, enabled: true })).statusCode,
    ).toBe(409);
    const removals = await Promise.all(
      Array.from({ length: 4 }, () =>
        http.remove({ ...identity, expectedRevision: 2 }),
      ),
    );
    expect(removals.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(
      removals.filter((response) => !response.json().replayed),
    ).toHaveLength(1);
    const removed = removals.find((response) => !response.json().replayed);
    if (!removed) throw new Error("卸载未返回唯一回执");
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({
      installationId: install.installationId,
      generation: 2,
      replayed: false,
    });
    const replay = await http.remove({ ...identity, expectedRevision: 2 });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ ...removed.json(), replayed: true });
    await expect(
      readFile(
        join(
          db.directory,
          "media-drivers",
          "versions",
          "registry-example",
          created.json().driver.currentVersion.id,
          "source.ts",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const lateInstall = await http.install(install);
    expect(lateInstall.statusCode).toBe(410);
    expect(applicationErrorResponseSchema.parse(lateInstall.json())).toEqual(
      lateInstall.json(),
    );
    expect(
      (await http.setEnabled({ ...identity, enabled: true })).statusCode,
    ).toBe(410);
    const fresh = await http.preview();
    expect(fresh.installationId).not.toBe(install.installationId);
    expect((await http.install(fresh)).statusCode).toBe(201);
    const lateUpdate = await http.update({ ...install, ...identity });
    expect(lateUpdate.statusCode).toBe(410);
    const oldFile = await http.source(created.json().driver.currentVersion.id);
    expect(oldFile.statusCode).toBe(404);
    const columns = await db.persistence.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema='public' and table_name='media_driver_removals' order by ordinal_position",
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "instance_id",
      "installation_id",
      "generation",
      "removed_at",
    ]);
  } finally {
    await http.app.close();
    await db.close();
  }
});

pgTest("在途任务和待处理取消阻止卸载，停用仍保留原文件", async () => {
  const db = await createTaskWorkDatabase();
  const http = await createRegistryHttp(db);
  const queue = createInProcessQueue();
  const jobs = createJobService({
    queue,
    localInstance: db.localInstance,
    repository: createJobRepository(db.persistence),
    generationTargets: createGenerationTargets({
      persistence: db.persistence,
      executionScopes: createExecutionScopes({
        repository: createScopeRepository(db.persistence),
        localInstance: db.localInstance,
      }),
    }),
  });
  try {
    const payload = await http.preview();
    const installed = await http.install(payload);
    const identity = {
      installationId: payload.installationId,
      expectedGeneration: 1,
      expectedRevision: 1,
    };
    const job = await jobs.createJob(db.actor, {
      jobType: "image_generation",
      payload: {
        prompt: "队列任务",
        _media_driver: { installationId: payload.installationId },
      },
    });
    const busy = await http.remove(identity);
    expect(busy.statusCode, busy.body).toBe(409);
    expect(busy.json().error.code).toBe("media_driver_in_use");
    const disabled = await http.setEnabled({ ...identity, enabled: false });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(
      (await http.source(installed.json().driver.currentVersion.id)).statusCode,
    ).toBe(200);
    await jobs.cancelJob(db.actor, job.id);
    const cancelling = await http.remove({ ...identity, expectedRevision: 2 });
    expect(cancelling.statusCode).toBe(409);
    const token = randomUUID();
    expect(await jobs.claimJob(job.id, token, 120)).toMatchObject({
      id: job.id,
      status: "canceled",
    });
    await jobs.saveCancellation(
      job.id,
      { state: "local_only", attempts: 1 },
      0,
      token,
    );
    const removed = await http.remove({ ...identity, expectedRevision: 2 });
    expect(removed.statusCode, removed.body).toBe(200);
  } finally {
    await queue.shutdown();
    await http.app.close();
    await db.close();
  }
});

pgTest.each([false, true])("卸载回包恢复（回滚=%s）", async (rollback) => {
  const db = await createTaskWorkDatabase();
  const proxy = await createCommitResponseLossProxy(db.connectionString);
  const persistence = createPostgresPersistence({
    databaseUrl: proxy.connectionString,
  });
  const http = await createRegistryHttp(db, persistence);
  try {
    const payload = await http.preview();
    const installed = await http.install(payload);
    const versionId = installed.json().driver.currentVersion.id;
    const path = join(
      db.directory,
      "media-drivers",
      "versions",
      "registry-example",
      versionId,
      "source.ts",
    );
    const identity = {
      installationId: payload.installationId,
      expectedGeneration: 1,
      expectedRevision: 1,
    };
    proxy.arm(payload.installationId, {
      mediaInstall: true,
      blackoutAfterCommit: !rollback,
      rollbackBeforeCommit: rollback,
    });
    const uncertain = await http.remove(identity);
    expect(uncertain.statusCode).toBe(500);
    expect(proxy.evidence().injected).toMatchObject({
      commitConfirmed: !rollback,
      replySuppressed: true,
    });
    expect(proxy.evidence().observerError).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(source);
    proxy.restore();
    await http.service().recover();
    const saved = await http.source(versionId);
    if (rollback) {
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().source).toBe(source);
    } else {
      expect(saved.statusCode).toBe(404);
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const replay = await http.remove(identity);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().replayed).toBe(!rollback);
    expect((await http.install(payload)).statusCode).toBe(410);
  } finally {
    proxy.restore();
    await http.app.close();
    await persistence.close();
    await proxy.close();
    await db.close();
  }
});

const filesystemPgTest = it.skipIf(
  process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1" ||
    process.platform === "win32" ||
    process.getuid?.() === 0,
);
filesystemPgTest("卸载清理失败给出中文提示，恢复后重放原回执", async () => {
  const db = await createTaskWorkDatabase();
  const http = await createRegistryHttp(db);
  const parent = join(
    db.directory,
    "media-drivers",
    "versions",
    "registry-example",
  );
  let restricted = false;
  try {
    const payload = await http.preview();
    await http.install(payload);
    const identity = {
      installationId: payload.installationId,
      expectedGeneration: 1,
      expectedRevision: 1,
    };
    await chmod(parent, 0o500);
    restricted = true;
    const failed = await http.remove(identity);
    expect(failed.statusCode, failed.body).toBe(503);
    expect(failed.json().error.code).toBe("media_driver_storage_error");
    expect(failed.body).not.toContain(db.directory);
    await chmod(parent, 0o700);
    restricted = false;
    await http.service().recover();
    const replay = await http.remove(identity);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect((await http.install(payload)).statusCode).toBe(410);
  } finally {
    if (restricted) await chmod(parent, 0o700);
    await http.app.close();
    await db.close();
  }
});
