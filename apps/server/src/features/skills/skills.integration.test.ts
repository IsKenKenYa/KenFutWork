import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createSkillCatalogRepository } from "./repository.js";

/**
 * skills 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明 `workspace_skills JOIN skills` 在真库上成立，且工作区谓词生效
 * （跨工作区安装的技能不可见）。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @kenfutwork/server exec vitest run skills.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const FOREIGN_WORKSPACE = "00000000-0000-0000-0000-000000000000";

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("skills 真实库集成", () => {
  it("已安装 skill 经 JOIN 取回，跨工作区不可见", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();

      const workspace = await createViewerRepository(
        persistence,
      ).findPersonalWorkspace((profile as IdRow).id);
      const workspaceId = workspace?.id as string;
      expect(workspaceId).toBeTruthy();

      const slug = `integration-skill-${Date.now().toString(36)}`;
      const skills = createSkillCatalogRepository(persistence);
      let skillId: string | undefined;

      try {
        const inserted = await persistence.queryOne<IdRow>(
          `insert into public.skills
                  (name, slug, description, author, version, category, source, skill_content)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id`,
          [
            "集成技能",
            slug,
            "集成测试用",
            "integration",
            "0.0.1",
            // category/source 受 CHECK 约束：见 skills_category_check / skills_source_check
            "custom",
            "user",
            "# 集成技能\n步骤…",
          ],
        );
        skillId = inserted?.id as string;

        await persistence.query(
          `insert into public.workspace_skills (workspace_id, skill_id, enabled)
           values ($1, $2, true)`,
          [workspaceId, skillId],
        );

        const rows = await skills.listWorkspaceSkills(workspaceId);
        const row = rows.find((entry) => entry.slug === slug);
        expect(row).toMatchObject({
          description: "集成测试用",
          enabled: true,
          skillContent: "# 集成技能\n步骤…",
        });

        // 跨工作区不可见（隔离门禁）
        await expect(
          skills.listWorkspaceSkills(FOREIGN_WORKSPACE),
        ).resolves.toEqual([]);
      } finally {
        if (skillId) {
          // workspace_skills 对 skills 是 ON DELETE CASCADE，删 skill 即连带清理
          await persistence.query("delete from public.skills where id = $1", [
            skillId,
          ]);
        }
      }
    } finally {
      await persistence.close();
    }
  });

  /**
   * 回归锁：`insertFilesForOwnedSkill` 是 `insert ... select ... from (values ...)`
   * 形状，Postgres 不会把目标列的 uuid 类型反推给未定型参数——漏了 `$1::uuid`
   * 就报 `operator does not exist: uuid = text`（SQLSTATE 42883）。
   *
   * 这条只在**真库执行**时才暴露：单测只断言 SQL 文本，当时全绿；路由又把该错误
   * 当非致命吞掉（skill 建了、文件没进），所以必须有一条真的跑起来。
   */
  it("写入路径可在真库执行：coalesce 缺省 + 批量插文件 + 非本人拒绝", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();
      const userId = (profile as IdRow).id;

      const skills = createSkillCatalogRepository(persistence);
      const slug = `integration-write-${Date.now().toString(36)}`;
      let skillId: string | undefined;

      try {
        const created = await skills.insertOwned(userId, {
          category: "custom",
          description: "写入路径集成测试",
          name: "集成写入技能",
          skillContent: "# 集成写入",
          slug,
        });
        skillId = created?.id as string;
        expect(skillId).toBeTruthy();

        // coalesce 复刻「列缺席即用列默认」：不传 author/version/metadata 时
        // 落库必须是列默认，而不是 NULL
        expect(created).toMatchObject({
          author: "system",
          metadata: {},
          source: "user",
          version: "1.0",
        });

        const written = await skills.insertFilesForOwnedSkill(userId, skillId, [
          { content: "print(1)", filePath: "scripts/a.py" },
          {
            content: "# b",
            filePath: "references/b.md",
            mimeType: "text/markdown",
          },
        ]);
        expect(written).toBe(2);

        const files = await skills.listFilesForVisibleSkill(userId, skillId);
        expect(files.map((f) => f.file_path)).toEqual([
          "references/b.md",
          "scripts/a.py",
        ]);
        expect(files.map((f) => f.mime_type)).toEqual([
          "text/markdown",
          "text/plain",
        ]);

        // 非本人不写入（父子校验内联在语句里，不靠 RLS）
        await expect(
          skills.insertFilesForOwnedSkill(FOREIGN_WORKSPACE, skillId, [
            { content: "x", filePath: "scripts/evil.py" },
          ]),
        ).resolves.toBe(0);

        await expect(
          skills.listFilesForVisibleSkill(FOREIGN_WORKSPACE, skillId),
        ).resolves.toEqual([]);

        // 非本人不可改、不可删
        await expect(
          skills.updateOwnedById(FOREIGN_WORKSPACE, skillId, {
            name: "hijack",
          }),
        ).resolves.toBeNull();
        await expect(
          skills.deleteOwnedById(FOREIGN_WORKSPACE, skillId),
        ).resolves.toBe(0);
      } finally {
        if (skillId) {
          // skill_files 对 skills 是 ON DELETE CASCADE，删 skill 即连带清理
          await persistence.query("delete from public.skills where id = $1", [
            skillId,
          ]);
        }
      }
    } finally {
      await persistence.close();
    }
  });
});
