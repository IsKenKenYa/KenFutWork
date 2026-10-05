import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createSkillCatalogRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "实例技能真实 Postgres",
  () => {
    it("本地技能和资源父链、安装幂等、卸载后迟到启停不能重装成立", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const repository = createSkillCatalogRepository(database.persistence);
        const skill = await repository.insertOwned(instanceId, {
          name: "本地技能",
          slug: `skill-${randomUUID()}`,
          category: "custom",
          description: "说明",
          skillContent: "正文",
          createdByClientId: null,
        });
        if (!skill || typeof skill.id !== "string")
          throw new Error("技能夹具未创建。");
        const skillId = skill.id;
        expect(
          await repository.insertFilesForOwnedSkill(instanceId, skillId, [
            { filePath: "scripts/run.py", content: "print(1)" },
          ]),
        ).toBe(1);
        expect(
          await repository.findVisibleById(randomUUID(), skillId),
        ).toBeNull();
        expect(
          await repository.listFilesForVisibleSkill(randomUUID(), skillId),
        ).toEqual([]);
        await repository.upsertInstallation({
          instanceId,
          installedByClientId: null,
          skillId,
          enabled: true,
        });
        await repository.upsertInstallation({
          instanceId,
          installedByClientId: null,
          skillId,
          enabled: true,
        });
        expect(
          (await repository.listInstanceSkills(instanceId)).filter(
            (item) => item.skillId === skillId,
          ),
        ).toHaveLength(1);
        expect(
          (await repository.listSkillFiles(instanceId, [skillId]))[0],
        ).toMatchObject({ path: "scripts/run.py", content: "print(1)" });
        expect(await repository.uninstall(instanceId, skillId)).toBe(1);
        expect(await repository.setEnabled(instanceId, skillId, true)).toBe(
          false,
        );
        expect(
          (await repository.listInstalled(instanceId)).some(
            (item) => item.skill_id === skillId,
          ),
        ).toBe(false);
        expect(await repository.deleteOwnedById(instanceId, skillId)).toBe(1);
      } finally {
        await database.close();
      }
    });
  },
);
