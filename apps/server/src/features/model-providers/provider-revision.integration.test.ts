import {
  providerInstanceCreateRequestSchema,
  providerInstanceListResponseSchema,
  providerInstanceResponseSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import { createCodeUiHttpFixture } from "../code-ui/code-ui-http.fixture.js";

/** 独占临时 PostgreSQL 与真实 HTTP，默认跳过；不读取现有数据库或凭据。 */
describe.skipIf(process.env.KENFUTWORK_PROVIDER_TEST_PG !== "1")(
  "供应商修订真实 HTTP/PG integration",
  () => {
    it("使用当前修订保存同值配置后，响应和重新读取均保持原修订", async () => {
      const fixture = await createCodeUiHttpFixture();
      const { request } = fixture.client;
      try {
        const input = providerInstanceCreateRequestSchema.parse({
          name: "同值配置供应商",
          protocol: "openai-compatible",
          baseUrl: "https://example.invalid/v1",
          enabled: false,
          models: [
            {
              id: "revision-model",
              name: "修订模型",
              capability: "chat",
              extraBody: { temperature: 0.5, reasoning_effort: "low" },
            },
          ],
          compat: { chatApi: "completions" },
          headers: { "x-first": "first", "x-second": "second" },
        });
        const createdResponse = await request("/api/provider-instances", input);
        expect(
          createdResponse.status,
          JSON.stringify(createdResponse.body),
        ).toBe(201);
        const created = providerInstanceResponseSchema.parse(
          createdResponse.body,
        );
        expect(created.configRevision).toBe(1);

        const savedResponse = await request(
          `/api/provider-instances/${created.id}`,
          {
            ...input,
            expectedRevision: created.configRevision,
            headers: { "x-second": "second", "x-first": "first" },
          },
          "PATCH",
        );
        expect(savedResponse.status, JSON.stringify(savedResponse.body)).toBe(
          200,
        );
        expect(
          providerInstanceResponseSchema.parse(savedResponse.body),
        ).toEqual(created);

        const reloadedResponse = await request("/api/provider-instances");
        expect(
          reloadedResponse.status,
          JSON.stringify(reloadedResponse.body),
        ).toBe(200);
        const reloaded = providerInstanceListResponseSchema.parse(
          reloadedResponse.body,
        );
        expect(
          reloaded.instances.find((provider) => provider.id === created.id),
        ).toEqual(created);
      } finally {
        await fixture.close();
      }
    });

    it("使用旧修订保存同值配置仍返回409，最新配置和修订保持不变", async () => {
      const fixture = await createCodeUiHttpFixture();
      const { request } = fixture.client;
      try {
        const createdResponse = await request("/api/provider-instances", {
          name: "旧修订供应商",
          protocol: "openai-compatible",
          enabled: false,
          models: [],
        });
        expect(
          createdResponse.status,
          JSON.stringify(createdResponse.body),
        ).toBe(201);
        const created = providerInstanceResponseSchema.parse(
          createdResponse.body,
        );
        const changedResponse = await request(
          `/api/provider-instances/${created.id}`,
          { enabled: true, expectedRevision: created.configRevision },
          "PATCH",
        );
        expect(
          changedResponse.status,
          JSON.stringify(changedResponse.body),
        ).toBe(200);
        const changed = providerInstanceResponseSchema.parse(
          changedResponse.body,
        );
        expect(changed).toMatchObject({ enabled: true, configRevision: 2 });

        const lateResponse = await request(
          `/api/provider-instances/${created.id}`,
          { enabled: true, expectedRevision: created.configRevision },
          "PATCH",
        );
        expect(lateResponse.status, JSON.stringify(lateResponse.body)).toBe(
          409,
        );
        expect(lateResponse.body).toMatchObject({
          error: { code: "instance_revision_conflict" },
        });

        const reloadedResponse = await request("/api/provider-instances");
        expect(
          reloadedResponse.status,
          JSON.stringify(reloadedResponse.body),
        ).toBe(200);
        const reloaded = providerInstanceListResponseSchema.parse(
          reloadedResponse.body,
        );
        expect(
          reloaded.instances.find((provider) => provider.id === created.id),
        ).toEqual(changed);
      } finally {
        await fixture.close();
      }
    });

    it("同一修订并发修改不同字段只接受一次，读取新修订重试后保留两项修改", async () => {
      const fixture = await createCodeUiHttpFixture();
      const { request } = fixture.client;
      try {
        const createdResponse = await request("/api/provider-instances", {
          name: "并发修改供应商",
          protocol: "openai-compatible",
          enabled: true,
          models: [],
        });
        expect(
          createdResponse.status,
          JSON.stringify(createdResponse.body),
        ).toBe(201);
        const created = providerInstanceResponseSchema.parse(
          createdResponse.body,
        );
        const changedName = "并发改名供应商";
        const responses = await Promise.all(
          [{ name: changedName }, { enabled: false }].map((patch) =>
            request(
              `/api/provider-instances/${created.id}`,
              { ...patch, expectedRevision: created.configRevision },
              "PATCH",
            ),
          ),
        );
        expect(responses.map((response) => response.status).sort()).toEqual([
          200, 409,
        ]);
        const winner = responses.find((response) => response.status === 200);
        const conflict = responses.find((response) => response.status === 409);
        if (!winner || !conflict)
          throw new Error("并发保存必须有一次成功和一次冲突。");
        expect(conflict.body).toMatchObject({
          error: { code: "instance_revision_conflict" },
        });

        const read = async () => {
          const response = await request("/api/provider-instances");
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          const { instances } = providerInstanceListResponseSchema.parse(
            response.body,
          );
          const provider = instances.find((item) => item.id === created.id);
          if (!provider) throw new Error("并发保存后供应商不可读取。");
          return provider;
        };
        const afterConcurrent = await read();
        const nameWon = responses[0]?.status === 200;
        expect(afterConcurrent).toEqual(
          providerInstanceResponseSchema.parse(winner.body),
        );
        expect(afterConcurrent).toMatchObject({
          name: nameWon ? changedName : created.name,
          enabled: nameWon,
          configRevision: 2,
        });

        const retried = await request(
          `/api/provider-instances/${created.id}`,
          {
            ...(nameWon ? { enabled: false } : { name: changedName }),
            expectedRevision: afterConcurrent.configRevision,
          },
          "PATCH",
        );
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        const combined = providerInstanceResponseSchema.parse(retried.body);
        expect(combined).toMatchObject({
          name: changedName,
          enabled: false,
          configRevision: 3,
        });
        expect(await read()).toEqual(combined);
      } finally {
        await fixture.close();
      }
    });

    it("普通配置同值时仍保存新凭据并推进修订，目录读取不包含凭据", async () => {
      const fixture = await createCodeUiHttpFixture();
      const { request } = fixture.client;
      try {
        const oldKey = "integration-credential-before";
        const newKey = "integration-credential-after";
        const input = providerInstanceCreateRequestSchema.parse({
          name: "凭据修订供应商",
          protocol: "openai-compatible",
          baseUrl: "https://example.invalid/v1",
          enabled: true,
          models: [
            { id: "credential-model", name: "凭据模型", capability: "chat" },
          ],
          compat: { chatApi: "completions" },
          headers: { "x-session": "{{sessionId}}" },
          apiKey: oldKey,
        });
        const createdResponse = await request("/api/provider-instances", input);
        expect(
          createdResponse.status,
          JSON.stringify(createdResponse.body),
        ).toBe(201);
        const created = providerInstanceResponseSchema.parse(
          createdResponse.body,
        );
        expect(created).toMatchObject({
          configRevision: 1,
          hasCredential: true,
        });

        const changedResponse = await request(
          `/api/provider-instances/${created.id}`,
          {
            ...input,
            apiKey: newKey,
            expectedRevision: created.configRevision,
          },
          "PATCH",
        );
        expect(
          changedResponse.status,
          JSON.stringify(changedResponse.body),
        ).toBe(200);
        const changed = providerInstanceResponseSchema.parse(
          changedResponse.body,
        );
        expect(changed).toEqual({ ...created, configRevision: 2 });

        const settingsResponse = await request("/api/code-ui/rpc", {
          service: "providerSettingsService",
          method: "getView",
          args: [],
        });
        expect(
          settingsResponse.status,
          JSON.stringify(settingsResponse.body),
        ).toBe(200);
        expect(
          settingsResponse.body.result.providers.find(
            (provider: { providerId: string }) =>
              provider.providerId === created.id,
          ),
        ).toMatchObject({
          credentialConfigured: true,
          personalConfig: { access: { apiKey: newKey } },
        });

        const reloadedResponse = await request("/api/provider-instances");
        expect(
          reloadedResponse.status,
          JSON.stringify(reloadedResponse.body),
        ).toBe(200);
        const reloaded = providerInstanceListResponseSchema.parse(
          reloadedResponse.body,
        );
        expect(
          reloaded.instances.find((provider) => provider.id === created.id),
        ).toEqual(changed);
        const publicBody = JSON.stringify(reloadedResponse.body);
        expect(publicBody).not.toContain(oldKey);
        expect(publicBody).not.toContain(newKey);
        expect(publicBody).not.toContain('"apiKey"');
      } finally {
        await fixture.close();
      }
    });

    it("删除供应商后迟到保存均返回404，重复删除保持幂等且列表不恢复", async () => {
      const fixture = await createCodeUiHttpFixture();
      const { request } = fixture.client;
      try {
        const createdResponse = await request("/api/provider-instances", {
          name: "删除后迟到保存供应商",
          protocol: "openai-compatible",
          enabled: false,
          models: [],
        });
        expect(
          createdResponse.status,
          JSON.stringify(createdResponse.body),
        ).toBe(201);
        const created = providerInstanceResponseSchema.parse(
          createdResponse.body,
        );
        const path = `/api/provider-instances/${created.id}`;
        const deleted = await request(path, undefined, "DELETE");
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);

        for (const name of [created.name, "删除后迟到改名供应商"]) {
          const late = await request(
            path,
            { name, expectedRevision: created.configRevision },
            "PATCH",
          );
          expect(late.status, JSON.stringify(late.body)).toBe(404);
          expect(late.body).toMatchObject({
            error: { code: "instance_not_found" },
          });
        }
        const deletedAgain = await request(path, undefined, "DELETE");
        expect(deletedAgain.status, JSON.stringify(deletedAgain.body)).toBe(
          204,
        );

        const reloadedResponse = await request("/api/provider-instances");
        expect(
          reloadedResponse.status,
          JSON.stringify(reloadedResponse.body),
        ).toBe(200);
        const reloaded = providerInstanceListResponseSchema.parse(
          reloadedResponse.body,
        );
        expect(
          reloaded.instances.filter((provider) => provider.id === created.id),
        ).toEqual([]);
      } finally {
        await fixture.close();
      }
    });
  },
);
