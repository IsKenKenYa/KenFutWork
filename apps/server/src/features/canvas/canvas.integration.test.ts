import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCanvasRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "实例画布真实 Postgres",
  () => {
    it("真实父链、内容覆盖、原子并发追加和越界拒绝成立", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const { canvas } = await createProjectRepository(
          database.persistence,
        ).createProject({
          instanceId,
          createdByClientId: null,
          name: "画布",
          slug: `canvas-${randomUUID()}`,
          description: null,
          canvasName: "主画布",
        });
        if (!canvas) throw new Error("主画布未创建。");
        const repository = createCanvasRepository(database.persistence);
        expect(
          await repository.saveContent(instanceId, canvas.id, {
            elements: [],
            files: {},
            appState: { theme: "light" },
          }),
        ).toBe(1);
        await Promise.all([
          repository.appendContent(instanceId, canvas.id, {
            elements: [{ id: "first", type: "rectangle" }],
            files: {},
          }),
          repository.appendContent(instanceId, canvas.id, {
            elements: [{ id: "second", type: "rectangle" }],
            files: {},
          }),
        ]);
        const row = await repository.findById(instanceId, canvas.id);
        expect(row?.content).toMatchObject({
          appState: { theme: "light" },
          elements: expect.arrayContaining([
            { id: "first", type: "rectangle" },
            { id: "second", type: "rectangle" },
          ]),
        });
        const foreign = randomUUID();
        expect(await repository.findById(foreign, canvas.id)).toBeNull();
        expect(
          await repository.saveContent(foreign, canvas.id, { elements: [] }),
        ).toBe(0);
      } finally {
        await database.close();
      }
    });
  },
);
