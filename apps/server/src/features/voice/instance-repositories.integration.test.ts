import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMcpServerStore } from "../mcp/server-store.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import {
  createVoiceDiagnoseStore,
  createVoiceRepository,
} from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_PERSISTENCE_TEST_PG !== "1")(
  "合并后语音与远程 MCP 的实例存储",
  () => {
    it("完整迁移重放与二次 no-op、逐列并发保存、冷连接读回和公开凭据边界", async () => {
      const db = await createTaskWorkDatabase();
      let cold: ReturnType<typeof createPostgresPersistence> | undefined;
      try {
        expect(db.replayed).toHaveLength(db.expectedMigrations);
        expect(db.secondReplay).toEqual([]);
        const voice = createVoiceRepository(db.persistence);
        const settings = {
          mode: "transcribe",
          listen: null,
          speakReplies: true,
        };
        await Promise.all([
          voice.upsertVoice(db.instanceId, settings),
          db.persistence
            .forInstance(db.instanceId)
            .execute(
              "insert into public.instance_settings(instance_id, default_model) values(:instance,$1) on conflict(instance_id) do update set default_model=excluded.default_model",
              ["retained-model"],
            ),
        ]);
        expect(await voice.findVoice(db.instanceId)).toEqual(settings);
        expect(await voice.findVoice(randomUUID())).toBeNull();
        const mcp = createMcpServerStore(db.persistence, db.localInstance);
        const remote = await mcp.create({
          name: "retained-remote",
          kind: "http",
          command: "",
          url: "http://127.0.0.1:9999/mcp",
          args: [],
          env: { TEST_KEY: "fixture-value" },
          headers: { Authorization: "Bearer fixture-token" },
          enabled: false,
        });
        expect(remote).toMatchObject({
          kind: "http",
          command: "",
          url: "http://127.0.0.1:9999/mcp",
        });
        expect(await mcp.listPublic()).toEqual([
          expect.objectContaining({
            envKeys: ["TEST_KEY"],
            headerKeys: ["Authorization"],
          }),
        ]);
        expect(JSON.stringify(await mcp.listPublic())).not.toContain(
          "fixture-value",
        );
        expect(JSON.stringify(await mcp.listPublic())).not.toContain(
          "fixture-token",
        );
        const report = { measuredAt: "fixture-time" };
        await createVoiceDiagnoseStore(db.persistence).save(report);
        await db.persistence.close();
        cold = createPostgresPersistence({ databaseUrl: db.connectionString });
        expect(
          await createVoiceRepository(cold).findVoice(db.instanceId),
        ).toEqual(settings);
        expect(await createVoiceDiagnoseStore(cold).load()).toEqual(report);
        expect(
          await cold
            .forInstance(db.instanceId)
            .queryOne(
              "select default_model from public.instance_settings where instance_id=:instance",
            ),
        ).toEqual({ default_model: "retained-model" });
        expect(
          await createMcpServerStore(cold, db.localInstance).findByName(
            "retained-remote",
          ),
        ).toMatchObject({ id: remote.id, kind: "http" });
      } finally {
        await cold?.close();
        await db.close();
      }
    }, 60_000);
  },
);
