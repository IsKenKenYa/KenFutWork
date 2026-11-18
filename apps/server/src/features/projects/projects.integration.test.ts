import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import {
  createProjectRepository,
  ProjectDirectoryConflictError,
} from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "实例项目真实 Postgres",
  () => {
    it("跨调用并发新建同目录只有一次被接纳；明确独立后同模式同目录可保留两个项目", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const root = join(database.directory, "shared-directory");
        await mkdir(root);
        const repository = createProjectRepository(database.persistence);
        const input = {
          instanceId: database.instanceId,
          createdByClientId: database.actor.accessClientId,
          name: "同名项目",
          kind: "code" as const,
          workDir: root,
          description: null,
          canvasName: "unused",
        };
        const results = await Promise.allSettled([
          repository.createProject({ ...input, slug: randomUUID() }),
          repository.createProject({ ...input, slug: randomUUID() }),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const failure = results.find((result) => result.status === "rejected");
        if (!failure || failure.status !== "rejected")
          throw new Error("并发目录冲突未出现");
        expect(failure.reason).toBeInstanceOf(ProjectDirectoryConflictError);
        const independent = await repository.createProject({
          ...input,
          slug: randomUUID(),
          directoryChoice: "independent",
        });
        const projects = await repository.findDirectoryProjects(
          database.instanceId,
          root,
        );
        expect(projects).toHaveLength(2);
        expect(new Set(projects.map((project) => project.id)).size).toBe(2);
        expect(
          projects.every(
            (project) =>
              project.kind === "code" &&
              project.enabled_modes.join() === "code",
          ),
        ).toBe(true);
        expect(
          projects.some((project) => project.id === independent.project.id),
        ).toBe(true);
      } finally {
        await database.close();
      }
    });
    it("默认工作方式全矩阵、按需画布、实例隔离与归档在真实库成立", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const repository = createProjectRepository(database.persistence);
        for (const kind of ["design", "code", "flow"] as const) {
          const result = await repository.createProject({
            instanceId,
            createdByClientId: null,
            name: kind,
            slug: `project-${randomUUID()}`,
            kind,
            description: null,
            canvasName: "主画布",
            ...(kind === "code" ? { workDir: database.directory } : {}),
          });
          expect(result.project).toMatchObject({
            kind,
            instance_id: instanceId,
          });
          if (kind === "flow")
            expect(result.canvas).toMatchObject({ is_primary: true });
          else expect(result.canvas).toBeNull();
          expect(result.project.enabled_modes).toEqual([kind]);
          expect(
            (await repository.listActive(instanceId, kind)).some(
              (project) => project.id === result.project.id,
            ),
          ).toBe(true);
          expect(
            await repository.findActiveById(randomUUID(), result.project.id),
          ).toBeNull();
          expect(await repository.archive(instanceId, result.project.id)).toBe(
            1,
          );
          expect(await repository.archive(instanceId, result.project.id)).toBe(
            0,
          );
          expect(
            await repository.findActiveById(instanceId, result.project.id),
          ).toBeNull();
        }
      } finally {
        await database.close();
      }
    });
    it("显式共享同一项目；库约束拒绝空值、重复与 Flow 混用", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const repository = createProjectRepository(database.persistence);
        const { project } = await repository.createProject({
          instanceId: database.instanceId,
          createdByClientId: database.actor.accessClientId,
          name: "共享项目",
          slug: `shared-${randomUUID()}`,
          kind: "code",
          workDir: database.directory,
          description: null,
          canvasName: "unused",
        });
        await repository.update(database.instanceId, project.id, {
          enabledModes: ["code", "design"],
        });
        for (const mode of ["code", "design"] as const) {
          expect(
            (await repository.listActive(database.instanceId, mode)).find(
              (entry) => entry.id === project.id,
            )?.enabled_modes,
          ).toEqual(["code", "design"]);
        }
        for (const modes of [
          [],
          ["code", "code"],
          ["code", "flow"],
          ["design"],
        ] as const) {
          await expect(
            repository.update(database.instanceId, project.id, {
              enabledModes: [...modes],
            }),
          ).rejects.toThrow();
          expect(
            (await repository.findActiveById(database.instanceId, project.id))
              ?.enabled_modes,
          ).toEqual(["code", "design"]);
        }
        const id = randomUUID();
        await database.persistence
          .forInstance(database.instanceId)
          .execute(
            "insert into public.projects (id,instance_id,name,slug,kind) values ($1,:instance,'直接入口',$2,'design')",
            [id, `direct-${id}`],
          );
        expect(
          (await repository.findActiveById(database.instanceId, id))
            ?.enabled_modes,
        ).toEqual(["design"]);
      } finally {
        await database.close();
      }
    });
  },
);
