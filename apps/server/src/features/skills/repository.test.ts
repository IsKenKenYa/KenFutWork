import { describe, expect, it } from "vitest";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import {
  createInstanceSkillSettingsRepository,
  createSkillCatalogRepository,
} from "./repository.js";

const INSTANCE_ID = "instance-1";
const SKILL_ID = "skill-1";
function fixture(rows: unknown[] = [], rowCount = rows.length) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query: PostgresQueryRunner["query"] = async (sql, values) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
    return { rowCount, rows };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("技能查询不打开任务宿主会话。");
    },
    end: async () => {},
  };
  const persistence = createPersistenceFromRunner(runner);
  return {
    calls,
    persistence,
    repository: createSkillCatalogRepository(persistence),
  };
}

describe("实例技能仓储", () => {
  it("目录及文件可见性都绑定稳定实例，创建客户端不能成为授权条件", async () => {
    const { calls, repository } = fixture();
    await repository.listVisible(INSTANCE_ID);
    await repository.findVisibleById(INSTANCE_ID, SKILL_ID);
    await repository.findVisibleSkill(INSTANCE_ID, SKILL_ID);
    await repository.listFilesForVisibleSkill(INSTANCE_ID, SKILL_ID);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.sql).toContain("instance_id = $");
      expect(call.sql).not.toContain("created_by_client_id =");
      expect(call.values.at(-1)).toBe(INSTANCE_ID);
    }
    expect(calls[3]?.sql).toContain(
      "join public.skills s on s.id = sf.skill_id",
    );
  });

  it("自定义技能只在本实例写入，审计客户端可空，默认元数据仍由数据库承担", async () => {
    const { calls, repository } = fixture([{ id: SKILL_ID }], 1);
    await repository.insertOwned(INSTANCE_ID, {
      name: "本地",
      slug: "local",
      category: "custom",
      description: "说明",
      skillContent: "正文",
      createdByClientId: null,
    });
    const creation = calls[0];
    expect(creation?.sql).toContain("created_by_client_id");
    expect(creation?.sql).toContain("coalesce($8, 'system')");
    expect(creation?.sql).toContain("coalesce($9, '1.0')");
    expect(creation?.values.at(-1)).toBe(INSTANCE_ID);
    expect(creation?.values.at(-2)).toBeNull();
    await repository.updateOwnedById(INSTANCE_ID, SKILL_ID, { name: "改名" });
    await repository.deleteOwnedById(INSTANCE_ID, SKILL_ID);
    for (const call of calls.slice(1)) {
      expect(call.sql).toContain("instance_id = $");
      expect(call.sql).toContain("source = 'user'");
    }
  });

  it("附带文件写入显式 UUID 定型，单条语句复验父技能实例及自定义类型", async () => {
    const { calls, repository } = fixture([], 2);
    expect(
      await repository.insertFilesForOwnedSkill(INSTANCE_ID, SKILL_ID, [
        { filePath: "scripts/a.ts", content: "a" },
        {
          filePath: "references/b.md",
          content: "b",
          mimeType: "text/markdown",
        },
      ]),
    ).toBe(2);
    expect(calls[0]?.sql).toContain("$1::uuid");
    expect(calls[0]?.sql).toContain("s.instance_id = $8 and s.source = 'user'");
    expect(calls[0]?.values).toEqual([
      SKILL_ID,
      "scripts/a.ts",
      "a",
      "text/plain",
      "references/b.md",
      "b",
      "text/markdown",
      INSTANCE_ID,
    ]);
    const count = calls.length;
    expect(
      await repository.insertFilesForOwnedSkill(INSTANCE_ID, SKILL_ID, []),
    ).toBe(0);
    expect(calls).toHaveLength(count);
  });

  it("安装前复验技能实例，显式安装幂等；父资源和安装两端都限定实例", async () => {
    const { calls, repository } = fixture();
    await repository.upsertInstallation({
      instanceId: INSTANCE_ID,
      skillId: SKILL_ID,
      enabled: true,
      installedByClientId: null,
    });
    expect(calls[0]?.sql).toContain(
      "where s.id = $1::uuid and s.instance_id = $4",
    );
    expect(calls[0]?.sql).toContain(
      "on conflict (instance_id, skill_id) do update set enabled = excluded.enabled",
    );
    expect(calls[0]?.values).toEqual([SKILL_ID, true, null, INSTANCE_ID]);
    await repository.listSkillFiles(INSTANCE_ID, [SKILL_ID]);
    await repository.listInstalled(INSTANCE_ID);
    await repository.listInstanceSkills(INSTANCE_ID);
    for (const call of calls.slice(1)) {
      expect(call.sql).toContain("ws.instance_id = $");
      expect(call.sql).toContain("s.instance_id = $");
      expect(call.values.at(-1)).toBe(INSTANCE_ID);
    }
  });

  it("启停只 UPDATE 现存安装，卸载后迟到请求返回 false，不重新 INSERT", async () => {
    const { calls, persistence, repository } = fixture();
    expect(await repository.setEnabled(INSTANCE_ID, SKILL_ID, false)).toBe(
      false,
    );
    expect(
      await createInstanceSkillSettingsRepository(persistence).setEnabled(
        INSTANCE_ID,
        SKILL_ID,
        true,
      ),
    ).toBe(false);
    expect(
      calls.every((call) =>
        call.sql.startsWith("update public.instance_skills"),
      ),
    ).toBe(true);
    expect(calls[0]?.values).toEqual([SKILL_ID, false, null, INSTANCE_ID]);
    expect(await repository.uninstall(INSTANCE_ID, SKILL_ID)).toBe(0);
  });
});
