import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createModelProviderRepository } from "./repository.js";

/** 显式开启，只用独占临时 Postgres，全量重放历史迁移；不连接 DATABASE_URL。 */
describe.skipIf(process.env.KENFUTWORK_PROVIDER_TEST_PG !== "1")(
  "本地供应商真实库仓储",
  () => {
    it("单一本地实例下元数据 jsonb 往返、修订与实例谓词成立，数据库无明文或加密 Key 列", async () => {
      const database = await createTaskWorkDatabase();
      try {
        expect(database.replayed).toHaveLength(database.expectedMigrations);
        expect(database.secondReplay).toHaveLength(0);
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const repository = createModelProviderRepository(database.persistence);
        const providerId = randomUUID();
        const models = [
          {
            id: "native",
            name: "原生",
            capability: "chat",
            systemMessage: false,
            extraBody: { reasoning_effort: "low" },
          },
        ];
        const created = await repository.insertInstance({
          id: providerId,
          instanceId,
          name: "本地供应商",
          protocol: "openai-compatible",
          apiKeyRef: providerId,
          enabled: true,
          models,
          compat: { chatApi: "completions" },
          headers: { "x-session": "{{sessionId}}" },
        });
        expect(created).toMatchObject({
          id: providerId,
          instance_id: instanceId,
          api_key_ref: providerId,
          config_revision: "1",
          models,
        });
        expect(await repository.findInstance(instanceId, providerId)).toEqual(
          created,
        );
        const changed = await repository.updateInstance(
          instanceId,
          providerId,
          { enabled: false, headers: {}, api_key_ref: null },
          1,
        );
        expect(changed).toMatchObject({
          enabled: false,
          headers: {},
          api_key_ref: null,
          config_revision: "2",
          models,
        });
        expect(
          await repository.updateInstance(
            instanceId,
            providerId,
            { name: "旧修订" },
            1,
          ),
        ).toBeNull();
        const foreignInstance = randomUUID();
        expect(
          await repository.findInstance(foreignInstance, providerId),
        ).toBeNull();
        expect(await repository.listInstances(foreignInstance)).toEqual([]);
        const columns = await database.persistence.query<{
          column_name: string;
        }>(
          "select column_name from information_schema.columns where table_schema='public' and table_name='provider_instances'",
        );
        expect(columns.map((column) => column.column_name)).toContain(
          "api_key_ref",
        );
        expect(columns.map((column) => column.column_name)).not.toContain(
          "encrypted_api_key",
        );
        expect(columns.map((column) => column.column_name)).not.toContain(
          "workspace_id",
        );
        expect(await repository.deleteInstance(instanceId, providerId)).toBe(1);
        expect(await repository.deleteInstance(instanceId, providerId)).toBe(0);
        expect(
          await repository.findInstance(instanceId, providerId),
        ).toBeNull();
      } finally {
        await database.close();
      }
    });
  },
);
