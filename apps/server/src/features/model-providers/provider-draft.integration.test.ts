import {
  providerInstanceCreateRequestSchema,
  providerInstanceUpdateRequestSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createModelProviderService } from "./model-provider-service.js";
import { createModelProviderRepository } from "./repository.js";

/** Only a disposable localhost PostgreSQL cluster; never DATABASE_URL. */
describe.skipIf(process.env.KENFUTWORK_PROVIDER_TEST_PG !== "1")(
  "原Provider UI draft/CAS真实隔离Postgres",
  () => {
    it("全迁移重放/noop后真实NULL草稿、同修订并发单赢家、清Key与跨工作区拒绝", async () => {
      const database = await createTaskWorkDatabase();
      try {
        expect(database.replayed).toHaveLength(database.expectedMigrations);
        expect(database.secondReplay).toHaveLength(0);
        expect(
          await database.persistence.queryOne<{ is_nullable: string }>(
            "select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'provider_instances' and column_name = 'encrypted_api_key'",
          ),
        ).toEqual({ is_nullable: "YES" });
        const workspaceId = database.context.scope.workspaceId;
        const workspace = await database.persistence.queryOne<{
          owner_user_id: string;
        }>("select owner_user_id from public.workspaces where id = $1", [
          workspaceId,
        ]);
        if (!workspace) throw new Error("隔离夹具工作区不存在。");
        const actor = {
          id: workspace.owner_user_id,
          email: "provider@integration.test",
          accessToken: "test",
          userMetadata: {},
        };
        const repository = createModelProviderRepository(database.persistence);
        const service = createModelProviderService({
          repository,
          credentialEnv: { credentialSecret: "private-provider-test-secret" },
          viewerService: {
            ensureViewer: async () => {
              throw new Error("此凭证夹具不调用资料引导。");
            },
            updateProfile: async () => {
              throw new Error("此凭证夹具不更新资料。");
            },
            resolveWorkspace: async () => ({
              id: workspaceId,
              name: "隔离工作区",
              ownerUserId: actor.id,
              type: "personal",
            }),
          },
        });
        const created = await service.createInstance(
          actor,
          providerInstanceCreateRequestSchema.parse({
            name: "原UI草稿",
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
          (await repository.findWorkspaceInstance(workspaceId, created.id))
            ?.encrypted_api_key,
        ).toBeNull();
        const attempts = await Promise.allSettled(
          ["并发A", "并发B"].map((name) =>
            service.updateInstance(
              actor,
              created.id,
              providerInstanceUpdateRequestSchema.parse({
                name,
                expectedRevision: created.configRevision,
              }),
            ),
          ),
        );
        expect(
          attempts.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const failure = attempts.find((result) => result.status === "rejected");
        if (failure?.status !== "rejected")
          throw new Error("并发CAS必须有一个冲突回执。");
        expect(failure.reason).toMatchObject({
          code: "instance_revision_conflict",
          statusCode: 409,
        });
        const [latest] = await service.listInstances(actor);
        if (!latest) throw new Error("供应商草稿丢失。");
        expect(latest.configRevision).toBe(2);
        const keyed = await service.updateInstance(
          actor,
          created.id,
          providerInstanceUpdateRequestSchema.parse({
            apiKey: "private-runtime-key",
            expectedRevision: latest.configRevision,
          }),
        );
        expect(keyed).toMatchObject({ hasCredential: true, configRevision: 3 });
        expect(JSON.stringify(keyed)).not.toContain("private-runtime-key");
        const cleared = await service.updateInstance(
          actor,
          created.id,
          providerInstanceUpdateRequestSchema.parse({
            apiKey: null,
            protocol: "anthropic",
            expectedRevision: keyed.configRevision,
          }),
        );
        expect(cleared).toMatchObject({
          hasCredential: false,
          protocol: "anthropic",
          configRevision: 4,
        });
        expect(
          (await repository.findWorkspaceInstance(workspaceId, created.id))
            ?.encrypted_api_key,
        ).toBeNull();
        await expect(
          service.resolveCredentials(actor, created.id),
        ).rejects.toMatchObject({
          code: "credential_unavailable",
          statusCode: 409,
        });
        await expect(
          repository.updateWorkspaceInstance(
            "00000000-0000-0000-0000-000000000000",
            created.id,
            { name: "越界" },
            cleared.configRevision,
          ),
        ).resolves.toBeNull();
        expect((await service.listInstances(actor))[0]?.name).not.toBe("越界");
        const system = await service.createSystemInstance(
          {
            name: "平台草稿",
            protocol: "openai-compatible",
            models: [],
          },
          actor.id,
        );
        expect(system).toMatchObject({
          hasCredential: false,
          configRevision: 1,
        });
        const systemAttempts = await Promise.allSettled(
          ["平台A", "平台B"].map((name) =>
            service.updateSystemInstance(system.id, {
              name,
              expectedRevision: system.configRevision,
            }),
          ),
        );
        expect(
          systemAttempts.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const systemFailure = systemAttempts.find(
          (result) => result.status === "rejected",
        );
        if (systemFailure?.status !== "rejected")
          throw new Error("平台并发CAS必须有冲突回执。");
        expect(systemFailure.reason).toMatchObject({
          code: "instance_revision_conflict",
          statusCode: 409,
        });
        await expect(
          service.updateSystemInstance(created.id, {
            name: "不可见",
            expectedRevision: cleared.configRevision,
          }),
        ).rejects.toMatchObject({
          code: "instance_not_found",
          statusCode: 404,
        });
      } finally {
        await database.close();
      }
    });
  },
);
