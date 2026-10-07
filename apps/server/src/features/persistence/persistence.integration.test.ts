import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { InstanceIsolationError } from "./errors.js";

/** 显式开启且使用独占临时集群；不读取或写入现有 DATABASE_URL。 */
describe.skipIf(process.env.KENFUTWORK_PERSISTENCE_TEST_PG !== "1")(
  "本地实例存储真实 Postgres",
  () => {
    it("稳定实例、参数绑定、事务提交回滚、时间戳及隔离拒绝在真实库成立", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const persistence = database.persistence;
        await persistence.ping();
        const instance = createLocalInstanceRepository(persistence);
        const instanceId = await instance.ensure();
        expect(await instance.ensure()).toBe(instanceId);
        const scoped = persistence.forInstance(instanceId);
        await scoped.execute(
          "insert into public.instance_settings (instance_id, default_model) values (:instance, $1) on conflict(instance_id) do update set default_model=excluded.default_model",
          ["first-model"],
        );
        expect(
          await scoped.queryOne<{ default_model: string }>(
            "select default_model from public.instance_settings where instance_id=:instance",
          ),
        ).toEqual({ default_model: "first-model" });
        await persistence.transaction(async (tx) => {
          await tx
            .forInstance(instanceId)
            .execute(
              "update public.instance_settings set default_model=$1 where instance_id=:instance",
              ["committed-model"],
            );
        });
        const failure = new Error("主动回滚");
        await expect(
          persistence.transaction(async (tx) => {
            await tx
              .forInstance(instanceId)
              .execute(
                "update public.instance_settings set default_model=$1 where instance_id=:instance",
                ["rolled-back-model"],
              );
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(
          await scoped.queryOne<{ default_model: string }>(
            "select default_model from public.instance_settings where instance_id=:instance",
          ),
        ).toEqual({ default_model: "committed-model" });
        expect(
          await persistence
            .forInstance(randomUUID())
            .queryOne(
              "select default_model from public.instance_settings where instance_id=:instance",
            ),
        ).toBeNull();
        await expect(
          scoped.query("select default_model from public.instance_settings"),
        ).rejects.toBeInstanceOf(InstanceIsolationError);
        await expect(
          persistence.transaction((tx) =>
            tx.forInstance(instanceId).query("select 1"),
          ),
        ).rejects.toBeInstanceOf(InstanceIsolationError);
        const time = await scoped.queryOne<{ zoned: string; unzoned: string }>(
          "select timestamptz '2026-10-05 08:00:00+08' as zoned, timestamp '2026-10-05 00:00:00' as unzoned from public.local_instances where id=:instance",
        );
        expect(time).toEqual({
          zoned: "2026-10-05T00:00:00.000Z",
          unzoned: "2026-10-05T00:00:00.000Z",
        });
      } finally {
        await database.close();
      }
    });
  },
);
