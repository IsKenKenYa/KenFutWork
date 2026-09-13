import { describe, expect, it } from "vitest";

import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createSkillCatalogRepository } from "./repository.js";

const USER_ID = "user-1";
const WORKSPACE_ID = "ws-1";
const SKILL_ID = "skill-1";

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string, values: unknown[]) => FakeResult = () => ({
    rowCount: 0,
    rows: [],
  }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text, values);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text, values) => run(text, values),
        release: () => {},
      };
    },
    async end() {},
  };

  return {
    calls,
    runner,
    sqls: () => calls.map((c) => c.text.replace(/\s+/g, " ").trim()),
  };
}

describe("skills repository：安装态（workspace 作用域）", () => {
  it("已安装列表 JOIN skills 且保持嵌套形状（ws.* + s.* 解构）", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [
        {
          skill_id: SKILL_ID,
          enabled: true,
          installed_at: "2026-09-13T00:00:00+00:00",
          id: SKILL_ID,
          slug: "canvas-design",
          name: "Canvas Design",
        },
      ],
    }));

    const rows = await createSkillCatalogRepository(
      createPersistenceFromRunner(runner),
    ).listInstalled(WORKSPACE_ID);

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("from public.workspace_skills ws");
    expect(sql).toContain("join public.skills s on s.id = ws.skill_id");
    expect(sql).toContain("where ws.workspace_id = $1");
    expect(sql).toContain("order by ws.installed_at desc");

    // 嵌套形状与旧 PostgREST 查询一致：ws 字段在外，skill 明细在 skills 里
    expect(rows[0]).toEqual({
      skill_id: SKILL_ID,
      enabled: true,
      installed_at: "2026-09-13T00:00:00+00:00",
      skills: { id: SKILL_ID, slug: "canvas-design", name: "Canvas Design" },
    });
  });

  it("安装/启停是同一条件 upsert（冲突即更新 enabled）", async () => {
    const { calls, runner } = createRunner();

    await createSkillCatalogRepository(
      createPersistenceFromRunner(runner),
    ).upsertInstallation({
      enabled: false,
      installedBy: USER_ID,
      skillId: SKILL_ID,
      workspaceId: WORKSPACE_ID,
    });

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("insert into public.workspace_skills");
    expect(sql).toContain(
      "on conflict (workspace_id, skill_id) do update set enabled = excluded.enabled",
    );
    expect(calls[0]?.values).toEqual([SKILL_ID, false, USER_ID, WORKSPACE_ID]);
  });

  it("卸载返回受影响行数（0 即未安装）", async () => {
    const hit = createRunner(() => ({ rowCount: 1, rows: [] }));
    await expect(
      createSkillCatalogRepository(
        createPersistenceFromRunner(hit.runner),
      ).uninstall(WORKSPACE_ID, SKILL_ID),
    ).resolves.toBe(1);
    expect(hit.sqls()[0]).toContain(
      "where workspace_id = $2 and skill_id = $1",
    );

    const miss = createRunner(() => ({ rowCount: 0, rows: [] }));
    await expect(
      createSkillCatalogRepository(
        createPersistenceFromRunner(miss.runner),
      ).uninstall(WORKSPACE_ID, SKILL_ID),
    ).resolves.toBe(0);
  });
});

describe("skills repository：可见性（用户作用域，「或」式谓词）", () => {
  it("可见性谓词必须保留内置/社区目录（不是纯 created_by）", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [{ id: SKILL_ID }],
    }));

    await expect(
      createSkillCatalogRepository(
        createPersistenceFromRunner(runner),
      ).findVisibleSkill(USER_ID, SKILL_ID),
    ).resolves.toEqual({ id: SKILL_ID });

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    // 回归锁：简化成 `created_by = :user` 会让内置目录对所有用户消失
    expect(sql).toContain(
      "and (source in ('system', 'community') or created_by = $2)",
    );
    expect(calls[0]?.values).toEqual([SKILL_ID, USER_ID]);
  });

  it("不可见（既非内置也非本人创建）时返回 null", async () => {
    const { runner } = createRunner();
    await expect(
      createSkillCatalogRepository(
        createPersistenceFromRunner(runner),
      ).findVisibleSkill(USER_ID, SKILL_ID),
    ).resolves.toBeNull();
  });
});
