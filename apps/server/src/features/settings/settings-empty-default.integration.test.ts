import {
  instanceSettingsResponseSchema,
  instanceSettingsUpdateRequestSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "../code-ui/code-ui-http.fixture.js";
import { createSettingsRepository } from "./repository.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "本机空默认模型的实例设置公开接口 integration",
  () => {
    it("初始未配置模型时局部保存autoCompact仍成功，真实空库默认值可由PATCH和GET完整返回", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const repository = createSettingsRepository(
          fixture.database.persistence,
        );
        const instanceId = fixture.actor.instanceId;
        // 不创建供应商、模型或全局defaultModel；原夹具初始没有设置行。
        expect(await repository.findDefaultModel(instanceId)).toBeNull();
        expect(await repository.findAutoCompactEnabled(instanceId)).toBeNull();
        const before = await fixture.client.request("/api/instance/settings");
        expect(before.status, JSON.stringify(before.body)).toBe(200);
        const initial = instanceSettingsResponseSchema.parse(before.body);
        expect(initial.settings.autoCompactEnabled).toBe(true);

        const payload = instanceSettingsUpdateRequestSchema.parse({
          autoCompactEnabled: false,
        });
        expect(payload).toEqual({ autoCompactEnabled: false });
        const updated = await fixture.client.request(
          "/api/instance/settings",
          payload,
          "PATCH",
        );
        const reread = await fixture.client.request("/api/instance/settings");

        // 先区分真实写入和公开响应：局部upsert采用原SQL的空模型默认值。
        const storedModel = await repository.findDefaultModel(instanceId);
        const storedAutoCompact =
          await repository.findAutoCompactEnabled(instanceId);
        expect(storedModel).toBe("");
        expect(storedAutoCompact).toBe(false);
        expect(
          updated.status,
          JSON.stringify({
            patch: updated.body,
            freshGet: reread.body,
            storedModel,
            storedAutoCompact,
          }),
        ).toBe(200);
        expect(reread.status, JSON.stringify(reread.body)).toBe(200);
        const saved = instanceSettingsResponseSchema.parse(updated.body);
        const current = instanceSettingsResponseSchema.parse(reread.body);
        expect(saved.settings).toEqual({
          ...initial.settings,
          defaultModel: "",
          autoCompactEnabled: false,
        });
        expect(current.settings).toEqual(saved.settings);
      } finally {
        await fixture.close();
      }
    }, 90_000); // 仅独占HTTP/PG夹具期限，非运行时治理值。

    it("显式空默认模型仍被拒绝，不保存同一PATCH中的其他设置", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const before = await fixture.client.request("/api/instance/settings");
        expect(before.status).toBe(200);
        const initial = instanceSettingsResponseSchema.parse(before.body);
        const rejected = await fixture.client.request(
          "/api/instance/settings",
          { defaultModel: "", autoCompactEnabled: false },
          "PATCH",
        );
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
        expect(rejected.body.error.code).toBe("invalid_request");
        const after = await fixture.client.request("/api/instance/settings");
        expect(after.status).toBe(200);
        expect(instanceSettingsResponseSchema.parse(after.body)).toEqual(
          initial,
        );
        const repository = createSettingsRepository(
          fixture.database.persistence,
        );
        expect(
          await repository.findDefaultModel(fixture.actor.instanceId),
        ).toBeNull();
        expect(
          await repository.findAutoCompactEnabled(fixture.actor.instanceId),
        ).toBeNull();
      } finally {
        await fixture.close();
      }
    }, 90_000);
  },
);
