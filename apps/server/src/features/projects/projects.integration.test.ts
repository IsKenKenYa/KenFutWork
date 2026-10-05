import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createProjectRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "实例项目真实 Postgres",
  () => {
    it("kind 全矩阵、原子主画布、实例隔离与归档在真实库成立", async () => {
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
          if (kind === "code") expect(result.canvas).toBeNull();
          else expect(result.canvas).toMatchObject({ is_primary: true });
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
  },
);
