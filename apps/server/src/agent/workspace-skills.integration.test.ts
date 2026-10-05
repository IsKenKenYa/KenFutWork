import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCanvasRepository } from "../features/canvas/repository.js";
import { createLocalInstanceRepository } from "../features/local-instance/repository.js";
import { createLocalInstanceService } from "../features/local-instance/service.js";
import { createPostgresPersistence } from "../features/persistence/providers/postgres.js";
import { createProjectRepository } from "../features/projects/repository.js";
import { createSkillCatalogRepository } from "../features/skills/repository.js";
import { createInstanceSkillsLoader } from "./workspace-skills.js";

/**
 * 技能加载缝真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：端到端证明「画布 → 项目 → 实例 → 已启用 skill + 附带文件」这条链
 * 在真库上成立，且停用技能不会被注入。
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
    const dataDir = await mkdtemp(join(tmpdir(), "kfw-skill-instance-"));

    try {
      const localInstance = createLocalInstanceService({
        repository: createLocalInstanceRepository(persistence),
        dataDir,
      });
      const actor = await localInstance.serviceActor();
      expect(actor.accessClientId).toBeNull();
      const { instanceId } = await localInstance.resolve(actor);
      expect(instanceId).toMatch(/^[0-9a-f-]{36}$/);

      const created = await createProjectRepository(persistence).createProject({
        canvasName: "技能集成画布",
        description: null,
        name: "技能集成项目",
        slug: `skills-int-${Date.now().toString(36)}`,
        createdByClientId: actor.accessClientId,
        instanceId,
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
          `insert into public.instance_skills (instance_id, skill_id, enabled)
           values ($1, $2, true), ($1, $3, false)`,
          [instanceId, activeSkillId, disabledSkillId],
        );

        await persistence.query(
          `insert into public.skill_files (skill_id, file_path, content)
           values ($1, $2, $3)`,
          [activeSkillId, "scripts/run.py", "print('hi')"],
        );

        const loader = createInstanceSkillsLoader({
          canvases: createCanvasRepository(persistence),
          skills: createSkillCatalogRepository(persistence),
        });

        const entries = await loader(instanceId, created.canvas.id);

        // 实例可能自带其它启用技能，故断言「含我的启用项、不含停用项」
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
        // 清理：文件 → 实例技能 → 技能 → 画布 → 项目
        if (activeSkillId) {
          await persistence.query(
            "delete from public.skill_files where skill_id = $1",
            [activeSkillId],
          );
        }
        await persistence.query(
          `delete from public.instance_skills
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
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("画布不存在时返回空数组（不起查询失败）", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });
    const dataDir = await mkdtemp(join(tmpdir(), "kfw-skill-instance-"));

    try {
      const localInstance = createLocalInstanceService({
        repository: createLocalInstanceRepository(persistence),
        dataDir,
      });
      const { instanceId } = await localInstance.getContext();
      const loader = createInstanceSkillsLoader({
        canvases: createCanvasRepository(persistence),
        skills: createSkillCatalogRepository(persistence),
      });

      await expect(
        loader(instanceId, "11111111-1111-1111-1111-111111111111"),
      ).resolves.toEqual([]);
    } finally {
      await persistence.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
