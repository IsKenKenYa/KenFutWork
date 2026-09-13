import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createModelProviderRepository } from "./repository.js";

/**
 * model-providers 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明工作区实例与平台池实例两种写入口径在真库上都成立——
 * 平台池要求 `scope='system'` 且 `workspace_id IS NULL`（CHECK 约束）、
 * models/compat 的 jsonb 往返、以及跨工作区不可读写。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @loomic/server exec vitest run model-providers.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const FOREIGN_WORKSPACE = "00000000-0000-0000-0000-000000000000";

type IdRow = { id: string };

const MODELS = [{ id: "gpt-4.1", name: "GPT-4.1", capability: "chat" }];

describe.skipIf(!DATABASE_URL)("model-providers 真实库集成", () => {
  it("工作区实例：写入→读回→更新→删除，跨工作区不可读写", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();
      const userId = (profile as IdRow).id;

      const workspace =
        await createViewerRepository(persistence).findPersonalWorkspace(userId);
      const workspaceId = workspace?.id as string;
      const instances = createModelProviderRepository(persistence);

      const created = await instances.insertWorkspaceInstance({
        compat: { streamUsage: true },
        createdBy: userId,
        encryptedApiKey: "v1:integration:tag:cipher",
        enabled: true,
        models: MODELS,
        name: `集成实例-${Date.now().toString(36)}`,
        protocol: "openai-compatible",
        workspaceId,
      });

      const instanceId = created?.id as string;
      expect(instanceId).toBeTruthy();

      try {
        expect(created?.scope).toBe("workspace");
        expect(created?.models).toEqual(MODELS);
        expect(created?.compat).toEqual({ streamUsage: true });

        const found = await instances.findWorkspaceInstance(
          workspaceId,
          instanceId,
        );
        expect(found?.name).toBe(created?.name);

        const renamed = await instances.updateWorkspaceInstance(
          workspaceId,
          instanceId,
          { enabled: false, name: "改名后" },
        );
        expect(renamed).toMatchObject({ enabled: false, name: "改名后" });
        // 未给出的列不被覆盖
        expect(renamed?.models).toEqual(MODELS);

        // 跨工作区：读不到、改不动、删不掉
        await expect(
          instances.findWorkspaceInstance(FOREIGN_WORKSPACE, instanceId),
        ).resolves.toBeNull();
        await expect(
          instances.updateWorkspaceInstance(FOREIGN_WORKSPACE, instanceId, {
            name: "越权",
          }),
        ).resolves.toBeNull();
        await expect(
          instances.deleteWorkspaceInstance(FOREIGN_WORKSPACE, instanceId),
        ).resolves.toBe(0);
        // 列表也不含外来工作区实例
        await expect(
          instances.listWorkspaceInstances(FOREIGN_WORKSPACE),
        ).resolves.toEqual([]);

        await expect(
          instances.deleteWorkspaceInstance(workspaceId, instanceId),
        ).resolves.toBe(1);
      } finally {
        await persistence.query(
          "delete from public.provider_instances where id = $1",
          [instanceId],
        );
      }
    } finally {
      await persistence.close();
    }
  });

  it("平台池实例：workspace_id 为 NULL 且 scope='system'，与工作区列表互不串行", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      const userId = (profile as IdRow).id;
      const instances = createModelProviderRepository(persistence);

      const created = await instances.insertSystemInstance({
        createdBy: userId,
        encryptedApiKey: "v1:integration:tag:pool",
        enabled: true,
        models: MODELS,
        name: `集成平台池-${Date.now().toString(36)}`,
        protocol: "openai-compatible",
      });

      const systemId = created?.id as string;
      expect(systemId).toBeTruthy();

      try {
        expect(created?.scope).toBe("system");
        expect(created?.workspace_id).toBeNull();

        const systemRows = await instances.listSystemInstances();
        expect(systemRows.map((row) => row.id)).toContain(systemId);
        // 平台池只出现在 system 列表
        expect(systemRows.every((row) => row.scope === "system")).toBe(true);

        // by-id 取数（worker 路径）不区分口径
        await expect(instances.findById(systemId)).resolves.toMatchObject({
          id: systemId,
        });

        await expect(instances.deleteSystemInstance(systemId)).resolves.toBe(1);
      } finally {
        await persistence.query(
          "delete from public.provider_instances where id = $1",
          [systemId],
        );
      }
    } finally {
      await persistence.close();
    }
  });
});
