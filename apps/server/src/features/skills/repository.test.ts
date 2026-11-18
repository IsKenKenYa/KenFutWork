import { describe, expect, it } from "vitest";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import {
  createInstanceSkillSettingsRepository,
  createProjectSkillRepository,
  createSkillCatalogRepository,
  createSkillImportReceiptRepository,
  SkillImportConflictError,
  SkillImportDeletedError,
  skillImportRequestKey,
} from "./repository.js";

const INSTANCE_ID = "instance-1";
const SKILL_ID = "skill-1";
const PROJECT_ID = "project-1";
const REQUEST_KEY = "a".repeat(64);
const DIGEST = "b".repeat(64);

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

/** 按语句类型分别作答的夹具：导入事务需要「先查回执、再建技能、最后写回执」。 */
function scriptedFixture(
  receiptRow: Record<string, unknown> | null,
  options: { skillId?: string } = {},
) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const skillId = options.skillId ?? SKILL_ID;
  const query: PostgresQueryRunner["query"] = async (sql, values) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, values });
    if (normalized.includes("pg_advisory_xact_lock")) {
      return { rowCount: 1, rows: [] };
    }
    if (normalized.startsWith("select status, skill_id")) {
      return {
        rowCount: receiptRow ? 1 : 0,
        rows: receiptRow ? [receiptRow] : [],
      };
    }
    if (normalized.includes("insert into public.skills")) {
      return { rowCount: 1, rows: [{ id: skillId }] };
    }
    return { rowCount: 1, rows: [] };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("技能导入不打开任务宿主会话。");
    },
    end: async () => {},
  };
  return {
    calls,
    persistence: createPersistenceFromRunner(runner),
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

describe("项目级技能仓储", () => {
  it("按真实项目 id 读写，项目与技能都必须属于同一实例", async () => {
    const { calls, persistence } = fixture();
    const repository = createProjectSkillRepository(persistence);

    await repository.findProject(INSTANCE_ID, PROJECT_ID);
    await repository.listProjectSkills(INSTANCE_ID, PROJECT_ID);
    await repository.upsertProjectSkill({
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      skillId: SKILL_ID,
      enabled: true,
    });
    await repository.setProjectSkillEnabled(
      INSTANCE_ID,
      PROJECT_ID,
      SKILL_ID,
      false,
    );

    for (const call of calls) {
      expect(call.sql).toContain("instance_id = $");
      expect(call.sql).not.toContain("workspace");
      expect(call.values.at(-1)).toBe(INSTANCE_ID);
    }
    expect(calls[2]?.sql).toContain(
      "join public.skills s on s.instance_id = p.instance_id",
    );
    expect(calls[2]?.sql).toContain("p.id = $1::uuid");
    expect(calls[2]?.sql).toContain("s.id = $2::uuid");
    expect(calls[2]?.sql).toContain(
      "on conflict (instance_id, project_id, skill_id)",
    );
    expect(calls[3]?.sql.startsWith("update public.project_skills")).toBe(true);
    expect(calls[3]?.sql).toContain("project_id = $1");
    expect(calls[3]?.sql).toContain("skill_id = $2");
  });

  it("项目不属于本实例时返回 null，界面据此不显示项目分档", async () => {
    const { persistence } = scriptedFixture(null);
    const repository = createProjectSkillRepository(persistence);
    expect(await repository.findProject(INSTANCE_ID, PROJECT_ID)).toBeNull();
    expect(await repository.listProjectSkills(INSTANCE_ID, PROJECT_ID)).toEqual(
      [],
    );
  });
});

describe("外部导入回执", () => {
  it("来源身份摘要稳定且不包含实例身份", () => {
    const key = skillImportRequestKey("/root/skills", "writer");
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(skillImportRequestKey("/root/skills", "writer")).toBe(key);
    expect(skillImportRequestKey("/root/skills", "other")).not.toBe(key);
    expect(skillImportRequestKey("/other/skills", "writer")).not.toBe(key);
  });

  it("首次导入写技能与回执同事务提交，并持同来源事务锁", async () => {
    const { calls, persistence } = scriptedFixture(null);
    const repository = createSkillImportReceiptRepository(persistence);

    const result = await repository.admitImport({
      instanceId: INSTANCE_ID,
      requestKey: REQUEST_KEY,
      parameterFingerprint: DIGEST,
      sourceRootPath: "/root/skills",
      sourceSlug: "writer",
      create: async () => ({ skillId: SKILL_ID }),
    });

    expect(result).toEqual({ kind: "created", skillId: SKILL_ID });
    const sql = calls.map((call) => call.sql);
    expect(sql[0]).toBe("begin");
    expect(sql.some((entry) => entry.includes("pg_advisory_xact_lock"))).toBe(
      true,
    );
    const receiptInsert = calls.find((call) =>
      call.sql.startsWith("insert into public.skill_import_receipts"),
    );
    expect(receiptInsert?.values).toEqual([
      REQUEST_KEY,
      SKILL_ID,
      DIGEST,
      "/root/skills",
      "writer",
      INSTANCE_ID,
    ]);
    expect(sql.at(-1)).toBe("commit");
  });

  it("同来源同摘要重放返回既有技能，不重复创建", async () => {
    const { calls, persistence } = scriptedFixture({
      parameter_fingerprint: DIGEST,
      skill_id: SKILL_ID,
      status: "imported",
    });
    const repository = createSkillImportReceiptRepository(persistence);

    const result = await repository.admitImport({
      instanceId: INSTANCE_ID,
      requestKey: REQUEST_KEY,
      parameterFingerprint: DIGEST,
      sourceRootPath: "/root/skills",
      sourceSlug: "writer",
      create: async () => {
        throw new Error("同来源同摘要不得再次创建。");
      },
    });

    expect(result).toEqual({ kind: "replayed", skillId: SKILL_ID });
    expect(
      calls.some((call) => call.sql.includes("insert into public.skills")),
    ).toBe(false);
    expect(
      calls.some((call) =>
        call.sql.startsWith("insert into public.skill_import_receipts"),
      ),
    ).toBe(false);
  });

  it("同来源不同摘要返回冲突，不静默覆盖", async () => {
    const { persistence } = scriptedFixture({
      parameter_fingerprint: DIGEST,
      skill_id: SKILL_ID,
      status: "imported",
    });
    const repository = createSkillImportReceiptRepository(persistence);

    await expect(
      repository.admitImport({
        instanceId: INSTANCE_ID,
        requestKey: REQUEST_KEY,
        parameterFingerprint: "c".repeat(64),
        sourceRootPath: "/root/skills",
        sourceSlug: "writer",
        create: async () => ({ skillId: SKILL_ID }),
      }),
    ).rejects.toBeInstanceOf(SkillImportConflictError);
  });

  it("删除后的迟到导入命中墓碑，返回已删除且不复活内容", async () => {
    const { calls, persistence } = scriptedFixture({
      parameter_fingerprint: null,
      skill_id: null,
      status: "deleted",
    });
    const repository = createSkillImportReceiptRepository(persistence);

    await expect(
      repository.admitImport({
        instanceId: INSTANCE_ID,
        requestKey: REQUEST_KEY,
        parameterFingerprint: DIGEST,
        sourceRootPath: "/root/skills",
        sourceSlug: "writer",
        create: async () => ({ skillId: SKILL_ID }),
      }),
    ).rejects.toBeInstanceOf(SkillImportDeletedError);
    expect(
      calls.some((call) => call.sql.includes("insert into public.skills")),
    ).toBe(false);
  });
});
