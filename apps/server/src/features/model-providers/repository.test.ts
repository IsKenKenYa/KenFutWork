import { describe, expect, it } from "vitest";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createModelProviderRepository } from "./repository.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[]) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
    return { rowCount: 0, rows: [] };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("供应商查询不需要长寿命会话。");
    },
    end: async () => {},
  };
  return {
    calls,
    repository: createModelProviderRepository(
      createPersistenceFromRunner(runner),
    ),
  };
}

describe("modelProviders 仓储（实例谓词与 CAS）", () => {
  it("列表、查询、探测缓存全都绑定 :instance，数据库不读取 Key", async () => {
    const { repository, calls } = fixture();
    await repository.listInstances(INSTANCE_ID);
    await repository.findInstance(INSTANCE_ID, PROVIDER_ID);
    await repository.setProbeResult(INSTANCE_ID, PROVIDER_ID, {
      probedAt: "2026-10-05T00:00:00Z",
    });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.sql).toMatch(/where instance_id = \$\d/);
      expect(call.values.at(-1)).toBe(INSTANCE_ID);
      expect(call.sql).toContain("api_key_ref");
      expect(call.sql).not.toContain("encrypted_api_key");
      expect(call.sql).not.toContain("workspace_id");
    }
    expect(calls[1]?.values).toEqual([PROVIDER_ID, INSTANCE_ID]);
    expect(calls[2]?.values).toEqual([
      '{"probedAt":"2026-10-05T00:00:00Z"}',
      PROVIDER_ID,
      INSTANCE_ID,
    ]);
  });

  it("创建只写引用与原模型 jsonb，先锁目录修订再写供应商并提交事务", async () => {
    const { repository, calls } = fixture();
    const models = [
      {
        id: "native",
        name: "原生",
        capability: "chat",
        systemMessage: false,
        extraBody: { thinking: { type: "enabled" } },
      },
    ];
    await repository.insertInstance({
      id: PROVIDER_ID,
      instanceId: INSTANCE_ID,
      name: "本地",
      protocol: "openai-compatible",
      apiKeyRef: PROVIDER_ID,
      enabled: true,
      models,
      headers: { "x-session": "{{sessionId}}" },
    });
    expect(calls[0]?.sql).toBe("begin");
    expect(calls[1]?.sql).toContain(
      "insert into public.provider_registry_revisions(instance_id,revision)",
    );
    expect(calls[2]?.sql).toContain("for update");
    const insertion = calls.find((call) =>
      call.sql.startsWith("insert into public.provider_instances"),
    );
    expect(insertion?.values).toEqual([
      PROVIDER_ID,
      "本地",
      "openai-compatible",
      null,
      PROVIDER_ID,
      JSON.stringify(models),
      null,
      '{"x-session":"{{sessionId}}"}',
      true,
      INSTANCE_ID,
    ]);
    expect(insertion?.sql).not.toContain("created_by");
    expect(insertion?.sql).not.toContain("scope");
    expect(calls.at(-1)?.sql).toBe("commit");
  });

  it("补丁只改显式字段，原 CAS 与实例参数不漂移；null 与 {} 都真实落库", async () => {
    const { repository, calls } = fixture();
    await repository.updateInstance(
      INSTANCE_ID,
      PROVIDER_ID,
      {
        api_key_ref: null,
        headers: {},
        protocol: "anthropic",
      },
      7,
    );
    const update = calls.find((call) =>
      call.sql.startsWith("update public.provider_instances"),
    );
    expect(update?.sql).toContain("config_revision = config_revision + 1");
    expect(update?.sql).toContain("protocol = $2");
    expect(update?.sql).toContain("api_key_ref = $3");
    expect(update?.sql).toContain("headers = $4::jsonb");
    expect(update?.sql).toContain("config_revision = $5");
    expect(update?.sql).toContain("instance_id = $6");
    expect(update?.values).toEqual([
      PROVIDER_ID,
      "anthropic",
      null,
      "{}",
      7,
      INSTANCE_ID,
    ]);
    expect(update?.sql).not.toContain("models =");
    const before = calls.length;
    expect(
      await repository.updateInstance(INSTANCE_ID, PROVIDER_ID, {}),
    ).toBeNull();
    expect(calls).toHaveLength(before);
  });

  it("删除也持实例目录锁，不存在全局按 id 删除路径", async () => {
    const { repository, calls } = fixture();
    await repository.deleteInstance(INSTANCE_ID, PROVIDER_ID);
    const deletion = calls.find((call) =>
      call.sql.startsWith("delete from public.provider_instances"),
    );
    expect(deletion?.sql).toContain("where instance_id = $2 and id = $1");
    expect(deletion?.values).toEqual([PROVIDER_ID, INSTANCE_ID]);
    expect(calls.at(-1)?.sql).toBe("commit");
  });
});
