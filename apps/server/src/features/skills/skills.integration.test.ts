import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import type { InstanceSqlClient } from "../persistence/types.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import {
  createProjectSkillRepository,
  createSkillCatalogRepository,
  createSkillImportReceiptRepository,
  insertOwnedSkillRecord,
  insertSkillFileRecords,
  SkillImportConflictError,
  SkillImportDeletedError,
  skillImportRequestKey,
} from "./repository.js";

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

    it("项目级启停按真实项目 id 生效，项目不存在时读不到分档", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const catalog = createSkillCatalogRepository(database.persistence);
        const projectSkills = createProjectSkillRepository(
          database.persistence,
        );
        const skill = await catalog.insertOwned(instanceId, {
          name: "项目技能",
          slug: `project-skill-${randomUUID()}`,
          category: "custom",
          description: "说明",
          skillContent: "正文",
          createdByClientId: null,
        });
        if (!skill || typeof skill.id !== "string") {
          throw new Error("技能夹具未创建。");
        }
        const projectRows = await database.persistence
          .forInstance(instanceId)
          .query<{ id: string }>(
            `insert into public.projects (instance_id, name, slug, kind)
             values (:instance, '技能项目', $1, 'design')
             returning id`,
            [`project-${randomUUID()}`],
          );
        const projectId = projectRows[0]?.id;
        if (!projectId) {
          throw new Error("项目夹具未创建。");
        }

        expect(await projectSkills.findProject(instanceId, projectId)).toEqual({
          id: projectId,
          name: "技能项目",
        });
        expect(
          await projectSkills.upsertProjectSkill({
            instanceId,
            projectId,
            skillId: skill.id,
            enabled: true,
          }),
        ).toBe(1);
        const initial = await projectSkills.listProjectSkills(
          instanceId,
          projectId,
        );
        expect(initial).toHaveLength(1);
        expect(initial[0]).toMatchObject({
          skillId: skill.id,
          enabled: true,
        });
        expect(
          await projectSkills.setProjectSkillEnabled(
            instanceId,
            projectId,
            skill.id,
            false,
          ),
        ).toBe(true);
        expect(
          (await projectSkills.listProjectSkills(instanceId, projectId))[0]
            ?.enabled,
        ).toBe(false);
        expect(
          await projectSkills.findProject(instanceId, randomUUID()),
        ).toBeNull();
        expect(
          await projectSkills.upsertProjectSkill({
            instanceId,
            projectId: randomUUID(),
            skillId: skill.id,
            enabled: true,
          }),
        ).toBe(0);
      } finally {
        await database.close();
      }
    });

    it("导入回执顺序重放、同键冲突、删除后墓碑与并发同键成立", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const catalog = createSkillCatalogRepository(database.persistence);
        const receipts = createSkillImportReceiptRepository(
          database.persistence,
        );
        const sourceRootPath = `/root/${randomUUID()}`;
        const sourceSlug = `writer-${randomUUID()}`;
        const requestKey = skillImportRequestKey(sourceRootPath, sourceSlug);
        const digest = "b".repeat(64);
        const create = async (client: InstanceSqlClient) => {
          const created = await insertOwnedSkillRecord(client, {
            name: "导入技能",
            slug: sourceSlug,
            category: "custom",
            description: "说明",
            skillContent: "正文",
            createdByClientId: null,
          });
          if (!created || typeof created.id !== "string") {
            throw new Error("导入技能未写入。");
          }
          await insertSkillFileRecords(client, created.id, [
            { filePath: "references/a.md", content: "a" },
          ]);
          return { skillId: created.id };
        };

        const first = await receipts.admitImport({
          instanceId,
          requestKey,
          parameterFingerprint: digest,
          sourceRootPath,
          sourceSlug,
          create,
        });
        expect(first.kind).toBe("created");
        const replayed = await receipts.admitImport({
          instanceId,
          requestKey,
          parameterFingerprint: digest,
          sourceRootPath,
          sourceSlug,
          create,
        });
        expect(replayed).toEqual({ kind: "replayed", skillId: first.skillId });
        expect(
          (await catalog.listVisible(instanceId)).filter(
            (row) => row.slug === sourceSlug,
          ),
        ).toHaveLength(1);

        await expect(
          receipts.admitImport({
            instanceId,
            requestKey,
            parameterFingerprint: "c".repeat(64),
            sourceRootPath,
            sourceSlug,
            create,
          }),
        ).rejects.toBeInstanceOf(SkillImportConflictError);

        const concurrentRoot = `/root/${randomUUID()}`;
        const concurrentSlug = `concurrent-${randomUUID()}`;
        const concurrentKey = skillImportRequestKey(
          concurrentRoot,
          concurrentSlug,
        );
        const concurrentCreate = async (client: InstanceSqlClient) => {
          const created = await insertOwnedSkillRecord(client, {
            name: "并发技能",
            slug: concurrentSlug,
            category: "custom",
            description: "",
            skillContent: "正文",
            createdByClientId: null,
          });
          if (!created || typeof created.id !== "string") {
            throw new Error("并发技能未写入。");
          }
          return { skillId: created.id };
        };
        const concurrent = await Promise.all([
          receipts.admitImport({
            instanceId,
            requestKey: concurrentKey,
            parameterFingerprint: digest,
            sourceRootPath: concurrentRoot,
            sourceSlug: concurrentSlug,
            create: concurrentCreate,
          }),
          receipts.admitImport({
            instanceId,
            requestKey: concurrentKey,
            parameterFingerprint: digest,
            sourceRootPath: concurrentRoot,
            sourceSlug: concurrentSlug,
            create: concurrentCreate,
          }),
        ]);
        expect(
          concurrent.filter((entry) => entry.kind === "created"),
        ).toHaveLength(1);
        expect(new Set(concurrent.map((entry) => entry.skillId)).size).toBe(1);
        expect(
          (await catalog.listVisible(instanceId)).filter(
            (row) => row.slug === concurrentSlug,
          ),
        ).toHaveLength(1);

        expect(await catalog.deleteOwnedById(instanceId, first.skillId)).toBe(
          1,
        );
        const tombstone = await database.persistence
          .forInstance(instanceId)
          .queryOne<Record<string, unknown>>(
            `select status, skill_id, parameter_fingerprint,
                    source_root_path, source_slug
               from public.skill_import_receipts
              where instance_id = :instance and request_key = $1`,
            [requestKey],
          );
        expect(tombstone).toEqual({
          status: "deleted",
          skill_id: null,
          parameter_fingerprint: null,
          source_root_path: null,
          source_slug: null,
        });
        await expect(
          receipts.admitImport({
            instanceId,
            requestKey,
            parameterFingerprint: digest,
            sourceRootPath,
            sourceSlug,
            create,
          }),
        ).rejects.toBeInstanceOf(SkillImportDeletedError);
      } finally {
        await database.close();
      }
    });
  },
);
