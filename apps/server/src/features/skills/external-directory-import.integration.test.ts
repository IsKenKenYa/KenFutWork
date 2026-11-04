import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import {
  importExternalSkill,
  scanExternalSkillDirectories,
} from "./external-directory-import.js";
import {
  createSkillCatalogRepository,
  createSkillImportReceiptRepository,
  SkillImportConflictError,
  SkillImportDeletedError,
} from "./repository.js";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);
const SCRATCH_ROOT = join(REPO_ROOT, ".scratch");
const homes: string[] = [];

function createHome(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const home = mkdtempSync(join(SCRATCH_ROOT, "skill-import-int-"));
  homes.push(home);
  return home;
}

const manifest = [
  "---",
  "name: Writer",
  "description: 写作技能",
  "---",
  "# Writer",
  "",
].join("\n");

const concurrentManifest = [
  "---",
  "name: Concurrent",
  "description: 并发技能",
  "---",
  "# Concurrent",
  "",
].join("\n");

function writePackage(
  home: string,
  slug = "writer",
  content = manifest,
): string {
  const root = join(home, ".claude", "skills");
  const packageDir = join(root, slug);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "SKILL.md"), content);
  return root;
}

afterAll(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("外部技能目录导入（真实 Postgres）", () => {
  it.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
    "导入落库、重放、变更冲突、删除墓碑与并发同键都一致",
    async () => {
      const database = await createTaskWorkDatabase();
      const home = createHome();
      const root = writePackage(home);
      try {
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const catalog = createSkillCatalogRepository(database.persistence);
        const receipts = createSkillImportReceiptRepository(
          database.persistence,
        );

        const first = await importExternalSkill({
          instanceId,
          homeDir: home,
          rootPath: root,
          relativePath: "writer",
          installedByClientId: null,
          receipts,
          catalog,
        });
        expect(first.replayed).toBe(false);
        expect(first.slug).toBe("writer");

        const skills = await database.persistence
          .forInstance(instanceId)
          .query<Record<string, unknown>>(
            `select s.slug, s.name, s.skill_content, s.metadata,
                  exists (
                    select 1 from public.instance_skills ws
                     where ws.instance_id = s.instance_id
                       and ws.skill_id = s.id
                       and ws.enabled
                  ) as installed
             from public.skills s
            where s.instance_id = :instance`,
          );
        expect(skills).toHaveLength(1);
        expect(skills[0]).toMatchObject({
          slug: "writer",
          name: "Writer",
          installed: true,
        });
        const files = await catalog.listSkillFiles(instanceId, [first.skillId]);
        expect(files).toEqual([]);

        const scanAfterImport = await scanExternalSkillDirectories({
          instanceId,
          homeDir: home,
          receipts,
        });
        expect(scanAfterImport.candidates[0]).toMatchObject({ imported: true });

        const replay = await importExternalSkill({
          instanceId,
          homeDir: home,
          rootPath: root,
          relativePath: "writer",
          installedByClientId: null,
          receipts,
          catalog,
        });
        expect(replay).toEqual({
          skillId: first.skillId,
          slug: "writer",
          name: "Writer",
          replayed: true,
        });

        writeFileSync(
          join(root, "writer", "SKILL.md"),
          `${manifest}\n补充内容\n`,
        );
        await expect(
          importExternalSkill({
            instanceId,
            homeDir: home,
            rootPath: root,
            relativePath: "writer",
            installedByClientId: null,
            receipts,
            catalog,
          }),
        ).rejects.toBeInstanceOf(SkillImportConflictError);

        const concurrentHome = createHome();
        const concurrentRoot = writePackage(
          concurrentHome,
          "concurrent",
          concurrentManifest,
        );
        const concurrent = await Promise.all([
          importExternalSkill({
            instanceId,
            homeDir: concurrentHome,
            rootPath: concurrentRoot,
            relativePath: "concurrent",
            installedByClientId: null,
            receipts,
            catalog,
          }),
          importExternalSkill({
            instanceId,
            homeDir: concurrentHome,
            rootPath: concurrentRoot,
            relativePath: "concurrent",
            installedByClientId: null,
            receipts,
            catalog,
          }),
        ]);
        expect(concurrent.filter((entry) => !entry.replayed)).toHaveLength(1);
        expect(new Set(concurrent.map((entry) => entry.skillId)).size).toBe(1);

        expect(await catalog.deleteOwnedById(instanceId, first.skillId)).toBe(
          1,
        );
        await expect(
          importExternalSkill({
            instanceId,
            homeDir: home,
            rootPath: root,
            relativePath: "writer",
            installedByClientId: null,
            receipts,
            catalog,
          }),
        ).rejects.toBeInstanceOf(SkillImportDeletedError);
      } finally {
        await database.close();
      }
    },
  );
});
