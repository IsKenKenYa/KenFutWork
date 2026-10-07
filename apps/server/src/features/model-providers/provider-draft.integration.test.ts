import { join } from "node:path";
import {
  providerInstanceCreateRequestSchema,
  providerInstanceUpdateRequestSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createLocalCredentialStore } from "./local-credential-store.js";
import { createModelProviderService } from "./model-provider-service.js";
import { createModelProviderRepository } from "./repository.js";

/** 独占临时数据库与数据目录，默认跳过；不连接开发或用户数据库。 */
describe.skipIf(process.env.KENFUTWORK_PROVIDER_TEST_PG !== "1")(
  "原供应商设置本地 draft/CAS 真实 Postgres",
  () => {
    it("真实 NULL 草稿、同修订 Key 并发单赢家、清除及重启读取都沿原设置语义", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const localInstance = createLocalInstanceService({
          repository: createLocalInstanceRepository(database.persistence),
          dataDir: join(database.directory, "local-data"),
        });
        const actor = await localInstance.serviceActor();
        const repository = createModelProviderRepository(database.persistence);
        const service = createModelProviderService({
          repository,
          localInstance,
        });
        const created = await service.createInstance(
          actor,
          providerInstanceCreateRequestSchema.parse({
            name: "原 UI 草稿",
            protocol: "openai-compatible",
            models: [],
          }),
        );
        expect(created).toMatchObject({
          hasCredential: false,
          configRevision: 1,
          models: [],
        });
        expect(
          (await repository.findInstance(actor.instanceId, created.id))
            ?.api_key_ref,
        ).toBeNull();
        const keys = ["private-concurrent-a", "private-concurrent-b"];
        const attempts = await Promise.allSettled(
          keys.map((apiKey) =>
            service.updateInstance(
              actor,
              created.id,
              providerInstanceUpdateRequestSchema.parse({
                apiKey,
                expectedRevision: 1,
              }),
            ),
          ),
        );
        const winners = attempts.flatMap((result, index) =>
          result.status === "fulfilled" ? [index] : [],
        );
        expect(winners).toHaveLength(1);
        const failure = attempts.find((result) => result.status === "rejected");
        if (failure?.status !== "rejected")
          throw new Error("并发 CAS 必须有一个冲突回执。");
        expect(failure.reason).toMatchObject({
          code: "instance_revision_conflict",
          statusCode: 409,
        });
        const [latest] = await service.listInstances(actor);
        if (!latest) throw new Error("供应商草稿丢失。");
        expect(latest.configRevision).toBe(2);
        expect(JSON.stringify(latest)).not.toContain("private-concurrent");
        expect(await service.readCredential(actor, created.id)).toBe(
          keys[winners[0] ?? -1],
        );
        const restarted = createModelProviderService({
          repository,
          localInstance: createLocalInstanceService({
            repository: createLocalInstanceRepository(database.persistence),
            dataDir: join(database.directory, "local-data"),
          }),
        });
        expect(
          (await restarted.resolveCredentialsById(created.id)).apiKey,
        ).toBe(keys[winners[0] ?? -1]);
        const cleared = await service.updateInstance(
          actor,
          created.id,
          providerInstanceUpdateRequestSchema.parse({
            apiKey: null,
            protocol: "anthropic",
            expectedRevision: latest.configRevision,
          }),
        );
        expect(cleared).toMatchObject({
          hasCredential: false,
          protocol: "anthropic",
          configRevision: 3,
        });
        expect(
          (await repository.findInstance(actor.instanceId, created.id))
            ?.api_key_ref,
        ).toBeNull();
        expect(
          await createLocalCredentialStore(
            join(database.directory, "local-data"),
          ).get(created.id),
        ).toBeNull();
        await expect(
          restarted.resolveCredentialsById(created.id),
        ).rejects.toMatchObject({
          code: "credential_unavailable",
          statusCode: 409,
        });
        await expect(
          service.readCredential(
            { instanceId: "foreign", accessClientId: null },
            created.id,
          ),
        ).rejects.toMatchObject({
          code: "instance_forbidden",
          statusCode: 403,
        });
      } finally {
        await database.close();
      }
    });
  },
);
