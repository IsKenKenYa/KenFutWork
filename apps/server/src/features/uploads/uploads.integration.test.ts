import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createUploadRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "实例资产真实 Postgres",
  () => {
    it("实例元数据、bigint 归一、父项目隔离和重复删除成立", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const repository = createUploadRepository(database.persistence);
        const input = {
          instanceId,
          createdByClientId: null,
          bucket: "project-assets",
          byteSize: 123456,
          mimeType: "image/png",
          objectPath: `${instanceId}/asset.png`,
        };
        const asset = await repository.insert(input);
        if (!asset) throw new Error("资产夹具未创建。");
        expect(asset).toMatchObject({
          instance_id: instanceId,
          byte_size: 123456,
          project_id: null,
        });
        expect(
          await repository.findLocation(randomUUID(), asset.id),
        ).toBeNull();
        expect(
          await repository.insert({
            ...input,
            objectPath: `${instanceId}/wrong-parent.png`,
            projectId: randomUUID(),
          }),
        ).toBeNull();
        expect(await repository.deleteById(instanceId, asset.id)).toBe(1);
        expect(await repository.deleteById(instanceId, asset.id)).toBe(0);
      } finally {
        await database.close();
      }
    });
  },
);
