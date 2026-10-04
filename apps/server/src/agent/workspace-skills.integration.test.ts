import { describe, expect, it } from "vitest";
import { createViewerRepository } from "../features/bootstrap/repository.js";
import { createCanvasRepository } from "../features/canvas/repository.js";
import { createPostgresPersistence } from "../features/persistence/providers/postgres.js";
import { createProjectRepository } from "../features/projects/repository.js";
import { createSkillCatalogRepository } from "../features/skills/repository.js";
import { createWorkspaceSkillsLoader } from "./workspace-skills.js";

/**
 * 技能加载缝真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：端到端证明「画布 → 项目 → 工作区 → 已启用 skill + 附带文件」这条链
 * 在真库上成立，且停用技能与跨工作区技能都不会被注入。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @kenfutwork/server exec vitest run workspace-skills.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("workspace-skills 真实库集成", () => {
  it("按画布加载已启用技能与其文件；停用技能不注入", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();
      const userId = (profile as IdRow).id;

      const workspace =
        await createViewerRepository(persistence).findPersonalWorkspace(userId);
      const workspaceId = workspace?.id as string;
      expect(workspaceId).toBeTruthy();

      const created = await createProjectRepository(
        persistence,
      ).createProject({
        canvasName: "技能集成画布",
        description: null,
        name: "技能集成项目",
        slug: `skills-int-${Date.now().toString(36)}`,
        userId,
        workspaceId,
      });
      if (!created.canvas) throw new Error("Design 夹具缺少主画布");

      const marker = `integration-skill-${Date.now().toString(36)}`;
      const disabledMarker = `${marker}-off`;
      let activeSkillId: string | undefined;
      let disabledSkillId: string | undefined;

      const insertSkill = async (slug: string, content: string) => {
        const row = await persistence.queryOne<IdRow>(
          `insert into public.skills
                  (name, slug, description, author, version, category, source, skill_content)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id`,
          [
            slug,
            slug,
            "集成测试用",
            "integration",
            "0.0.1",
            "custom",
            "user",
            content,
          ],
        );
        return row?.id as string;
      };

      try {
        activeSkillId = await insertSkill(marker, "# 集成技能\n步骤…");
        disabledSkillId = await insertSkill(disabledMarker, "# 停用技能");

        await persistence.query(
          `insert into public.workspace_skills (workspace_id, skill_id, enabled)
           values ($1, $2, true), ($1, $3, false)`,
          [workspaceId, activeSkillId, disabledSkillId],
        );

        await persistence.query(
          `insert into public.skill_files (skill_id, file_path, content)
           values ($1, $2, $3)`,
          [activeSkillId, "scripts/run.py", "print('hi')"],
        );

        const loader = createWorkspaceSkillsLoader({
          canvases: createCanvasRepository(persistence),
          skills: createSkillCatalogRepository(persistence),
        });

        const entries = await loader(created.canvas.id);

        // 种子工作区可能自带其它启用技能，故断言「含我的启用项、不含停用项」
        const names = entries.map((entry) => entry.name);
        expect(names).toContain(marker);
        expect(names).not.toContain(disabledMarker);

        const mine = entries.find((entry) => entry.name === marker);
        expect(mine).toMatchObject({
          content: "# 集成技能\n步骤…",
          description: "集成测试用",
          path: `/workspace-skills/${marker}/SKILL.md`,
        });
        // 文件随技能一起注入
        expect(mine?.files).toEqual([
          { content: "print('hi')", path: "scripts/run.py" },
        ]);
      } finally {
        // 清理：文件 → 工作区技能 → 技能 → 画布 → 项目
        if (activeSkillId) {
          await persistence.query(
            "delete from public.skill_files where skill_id = $1",
            [activeSkillId],
          );
        }
        await persistence.query(
          `delete from public.workspace_skills
            where skill_id = any($1::uuid[])`,
          [[activeSkillId, disabledSkillId].filter(Boolean)],
        );
        await persistence.query(
          "delete from public.skills where id = any($1::uuid[])",
          [[activeSkillId, disabledSkillId].filter(Boolean)],
        );
        await persistence.query(
          "delete from public.canvases where project_id = $1",
          [created.project.id],
        );
        await persistence.query("delete from public.projects where id = $1", [
          created.project.id,
        ]);
      }
    } finally {
      await persistence.close();
    }
  });

  it("画布不存在时返回空数组（不起查询失败）", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const loader = createWorkspaceSkillsLoader({
        canvases: createCanvasRepository(persistence),
        skills: createSkillCatalogRepository(persistence),
      });

      await expect(
        loader("11111111-1111-1111-1111-111111111111"),
      ).resolves.toEqual([]);
    } finally {
      await persistence.close();
    }
  });
});
