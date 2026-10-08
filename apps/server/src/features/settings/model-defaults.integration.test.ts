import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "../code-ui/code-ui-http.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "统一模型默认的公开实例设置 integration",
  () => {
    it("数据库拒绝同请求的设置写入时，合法模型默认也整体回滚", async () => {
      const fixture = await createCodeUiHttpFixture();
      const admin = new Client({
        connectionString: fixture.database.connectionString,
      });
      try {
        await admin.connect();
        expect(fixture.database.secondReplay).toEqual([]);
        const schema = await admin.query(
          `select data_type, is_nullable from information_schema.columns
           where table_schema='public' and table_name='instance_settings'
           and column_name='model_defaults'`,
        );
        expect(schema.rows).toEqual([
          { data_type: "jsonb", is_nullable: "NO" },
        ]);
        await admin.query(`
          create function public.fail_model_defaults_fixture() returns trigger
          language plpgsql as $$ begin
            if NEW.user_rules = '测试写入失败' then
              raise exception 'fixture write rejected';
            end if;
            return NEW;
          end $$;
          create trigger fail_model_defaults_fixture
          before insert or update on public.instance_settings
          for each row execute function public.fail_model_defaults_fixture();
        `);
        const provider = await fixture.client.request(
          "/api/provider-instances",
          {
            name: "原子默认写入",
            protocol: "openai-compatible",
            apiKey: "fixture-no-external-call",
            models: [{ id: "chat", name: "聊天", capability: "chat" }],
          },
        );
        expect(provider.status).toBe(201);
        const before = await fixture.client.request("/api/instance/settings");
        expect(before.status).toBe(200);
        const failed = await fixture.client.request(
          "/api/instance/settings",
          {
            modelDefaults: {
              chat: { providerId: provider.body.id, modelId: "chat" },
              image: { mode: "auto" },
              video: { mode: "auto" },
            },
            userRules: "测试写入失败",
          },
          "PATCH",
        );
        expect(failed.status, JSON.stringify(failed.body)).toBe(500);
        expect(failed.body.error.code).toBe("settings_update_failed");
        const after = await fixture.client.request("/api/instance/settings");
        expect(after.status).toBe(200);
        expect(after.body.settings).toEqual(before.body.settings);
      } finally {
        await admin.end();
        await fixture.close();
      }
    }, 90_000); // 仅在本用例新建的 PG 内注入失败，不操作现有实例。

    it("不能保存不存在的手动候选，失败不会写入同请求其他设置", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const before = await fixture.client.request("/api/instance/settings");
        expect(before.status).toBe(200);
        const failed = await fixture.client.request(
          "/api/instance/settings",
          {
            userRules: "不能部分写入",
            modelDefaults: {
              chat: null,
              image: {
                mode: "manual",
                models: [
                  {
                    providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
                    modelId: "不存在",
                  },
                ],
              },
              video: { mode: "auto" },
            },
          },
          "PATCH",
        );
        expect(failed.status, JSON.stringify(failed.body)).toBe(400);
        expect(failed.body.error.code).toBe("invalid_model");
        const after = await fixture.client.request("/api/instance/settings");
        expect(after.status).toBe(200);
        expect(after.body.settings).toEqual(before.body.settings);
      } finally {
        await fixture.close();
      }
    }, 90_000); // 独占真实 PG/HTTP 的测试期限，不是业务限额。

    it("模型默认可跨请求保存，其他设置的稀疏更新不重置聊天与图视频策略", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const provider = await fixture.client.request(
          "/api/provider-instances",
          {
            name: "统一模型契约",
            protocol: "openai-compatible",
            apiKey: "fixture-no-external-call",
            models: [
              { id: "chat/中文", name: "聊天", capability: "chat" },
              { id: "image/α", name: "图像", capability: "image" },
            ],
          },
        );
        expect(provider.status, JSON.stringify(provider.body)).toBe(201);
        const providerId = provider.body.id;
        const defaults = {
          chat: { providerId, modelId: "chat/中文" },
          image: {
            mode: "manual",
            models: [{ providerId, modelId: "image/α" }],
          },
          video: { mode: "auto" },
        };
        const saved = await fixture.client.request(
          "/api/instance/settings",
          { modelDefaults: defaults },
          "PATCH",
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.settings.modelDefaults).toEqual(defaults);
        const sparse = await fixture.client.request(
          "/api/instance/settings",
          { userRules: "保持模型身份" },
          "PATCH",
        );
        expect(sparse.status, JSON.stringify(sparse.body)).toBe(200);
        const current = await fixture.client.request("/api/instance/settings");
        expect(current.status, JSON.stringify(current.body)).toBe(200);
        expect(current.body.settings).toMatchObject({
          modelDefaults: defaults,
          userRules: "保持模型身份",
        });
      } finally {
        await fixture.close();
      }
    }, 90_000); // 独占真实 PG/HTTP 的测试期限，不是业务限额。
  },
);
