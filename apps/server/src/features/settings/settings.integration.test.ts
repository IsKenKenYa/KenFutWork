import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createSettingsRepository } from "./repository.js";
import { createSettingsService } from "./settings-service.js";

/** 默认跳过；只创建临时集群、重放唯一 SQL 历史，不接入开发或用户数据库。 */
describe.skipIf(process.env.KENFUTWORK_SETTINGS_TEST_PG !== "1")(
  "实例设置真实 Postgres",
  () => {
    it("单实例 upsert、不同列并发、JSON 治理合并、回调读回及越界拒绝成立", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const localInstance = createLocalInstanceService({
          repository: createLocalInstanceRepository(database.persistence),
          dataDir: join(database.directory, "local-data"),
        });
        const actor = await localInstance.serviceActor();
        const repository = createSettingsRepository(database.persistence);
        const service = createSettingsService({ localInstance, repository });
        const events: unknown[] = [];
        const dispose = service.onUpdated(async (event) => {
          events.push({
            event,
            settings: await service.getInstanceSettings(
              actor,
              event.instanceId,
            ),
          });
        });
        const value = [
          { name: "inspect", description: "检查", prompt: "检查项目" },
        ];
        await service.updateInstanceSettings(actor, actor.instanceId, {
          commands: value,
          hooks: [{ event: "turn-end", command: "echo done" }],
          userRules: "中文",
          ruleEntries: ["保留配置"],
        });
        expect(await repository.findCommands(actor.instanceId)).toEqual(value);
        expect(events).toHaveLength(1);
        dispose();
        await Promise.all([
          service.updateInstanceSettings(actor, actor.instanceId, {
            defaultModel: "model-a",
          }),
          service.updateInstanceSettings(actor, actor.instanceId, {
            codeIndexEnabled: true,
          }),
        ]);
        await Promise.all([
          service.updateInstanceSettings(actor, actor.instanceId, {
            localAccessTicketTtlMs: 45_000,
          }),
          service.updateInstanceSettings(actor, actor.instanceId, {
            localAccessSessionMaxAgeMs: 180_000,
          }),
        ]);
        const settings = await service.getInstanceSettings(
          actor,
          actor.instanceId,
        );
        expect(settings).toMatchObject({
          defaultModel: "model-a",
          codeIndexEnabled: true,
          localAccessTicketTtlMs: 45_000,
          localAccessSessionMaxAgeMs: 180_000,
          commands: value,
          userRules: "中文",
          ruleEntries: ["保留配置"],
        });
        expect(events).toHaveLength(1);
        expect(await repository.findDefaultModel(randomUUID())).toBeNull();
        await expect(
          service.updateInstanceSettings(actor, randomUUID(), {
            defaultModel: "foreign",
          }),
        ).rejects.toMatchObject({
          code: "settings_forbidden",
          statusCode: 403,
        });
        expect(await repository.findDefaultModel(actor.instanceId)).toBe(
          "model-a",
        );
      } finally {
        await database.close();
      }
    });
  },
);
