import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createInstanceSkillsByInstanceLoader,
  createInstanceSkillsLoader,
} from "../../agent/workspace-skills.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import {
  createProjectSkillRepository,
  createSkillCatalogRepository,
} from "./repository.js";
import { createSkillCatalogService } from "./skill-catalog-service.js";
import { createInstanceSkillResourceReader } from "./skill-resource-service.js";

async function installSkill(
  database: Awaited<ReturnType<typeof createTaskWorkDatabase>>,
) {
  const { persistence, instanceId } = database;
  const repository = createSkillCatalogRepository(persistence);
  const slug = `project-runtime-${randomUUID()}`;
  const skill = await repository.insertOwned(instanceId, {
    name: "项目技能",
    slug,
    category: "custom",
    description: "项目运行回归",
    skillContent: "# 项目技能正文",
  });
  if (typeof skill?.id !== "string") throw new Error("技能未创建。");
  const skillId = skill.id;
  await repository.upsertInstallation({
    instanceId,
    skillId,
    enabled: true,
    installedByClientId: null,
  });
  await repository.insertFilesForOwnedSkill(instanceId, skillId, [
    { filePath: "references/说明.md", content: "附属资源" },
  ]);
  return { repository, slug, skillId };
}

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "项目技能运行时真实 Postgres integration",
  () => {
    it("项目启停覆盖实例默认，并同时作用于 Code、Design、目录和资源读取", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const { persistence, instanceId, localInstance } = database;
        const projectId = database.context.scope.projectId;
        await persistence
          .forInstance(instanceId)
          .execute(
            "update public.projects set enabled_modes=array['code','design']::text[] where instance_id=:instance and id=$1",
            [projectId],
          );
        const canvases = createCanvasRepository(persistence);
        const canvasId = randomUUID();
        expect(
          await canvases.create({
            instanceId,
            projectId,
            canvasId,
            name: "技能画布",
          }),
        ).toMatchObject({ id: canvasId });
        const { repository, slug, skillId } = await installSkill(database);
        const projectSkills = createProjectSkillRepository(persistence);
        const setProject = (enabled: boolean) =>
          projectSkills.upsertProjectSkill({
            instanceId,
            projectId,
            skillId,
            enabled,
          });
        const loadCode = createInstanceSkillsByInstanceLoader({
          skills: repository,
        });
        const loadDesign = createInstanceSkillsLoader({
          skills: repository,
          canvases,
        });
        const catalog = createSkillCatalogService({
          repository,
          localInstance,
        });
        const resources = createInstanceSkillResourceReader({
          repository,
          localInstance,
        });
        const check = async (enabled: boolean) => {
          expect(
            (await loadCode(instanceId, projectId)).some(
              (entry) => entry.name === slug,
            ),
          ).toBe(enabled);
          expect(
            (await loadDesign(instanceId, canvasId)).some(
              (entry) => entry.name === slug,
            ),
          ).toBe(enabled);
          expect(
            (await catalog.listSkills(instanceId, "code", projectId)).find(
              (entry) => entry.name === slug,
            )?.enabled,
          ).toBe(enabled);
          const detail = await catalog.getSkill(
            instanceId,
            slug,
            "code",
            projectId,
          );
          const resource = await resources.read(
            instanceId,
            slug,
            "references/说明.md",
            "code",
            projectId,
          );
          if (enabled) {
            expect(detail?.content).toBe("# 项目技能正文");
            expect(resource?.content).toBe("附属资源");
          } else {
            expect(detail).toBeUndefined();
            expect(resource).toBeUndefined();
          }
        };
        await check(true);
        await setProject(false);
        await check(false);
        expect(
          (await repository.listInstanceSkills(instanceId)).find(
            (entry) => entry.skillId === skillId,
          )?.enabled,
        ).toBe(true);
        await repository.setEnabled(instanceId, skillId, false);
        await setProject(true);
        await check(true);
        expect(await loadCode(instanceId)).toEqual([]);
        expect(await loadCode(instanceId, randomUUID())).toEqual([]);
        await setProject(false);
        await check(false);
        await setProject(true);
        await repository.uninstall(instanceId, skillId);
        expect(await loadCode(instanceId, projectId)).toEqual([]);
        expect(
          await resources.read(instanceId, slug, "SKILL.md", "code", projectId),
        ).toBeUndefined();
      } finally {
        await database.close();
      }
    }, 90_000);
  },
);
