import { describe, expect, it, vi } from "vitest";
import { createJobRepository } from "../jobs/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createPostgresPersistence } from "./providers/postgres.js";

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "后台终态真实Postgres通知",
  () => {
    it("独立worker连接提交Job终态后通知到达，只发送真实JobID", async () => {
      const db = await createTaskWorkDatabase();
      const worker = createPostgresPersistence({
        databaseUrl: db.connectionString,
      });
      const received: string[] = [];
      let release = async () => {};
      try {
        const subscription = await db.persistence.subscribeNotifications(
          "kenfutwork_generation_complete",
          (payload) => received.push(payload),
        );
        release = subscription.release;
        const repository = createJobRepository(worker);
        const row = await repository.insert({
          instanceId: db.instanceId,
          jobType: "image_generation",
          queueName: "image_generation_jobs",
          createdByClientId: db.actor.accessClientId,
          payload: {},
          fileTarget: { kind: "standalone" },
        });
        if (!row) throw new Error("通知夹具未创建Job");
        await repository.markRunning(row.id);
        await repository.markSucceeded(row.id, {
          publication: "transport-test",
        });
        await vi.waitFor(() => expect(received).toEqual([row.id]));
        expect((await repository.findById(row.id))?.status).toBe("succeeded");
        await repository.markSucceeded(row.id, {
          publication: "late-overwrite",
        });
        expect((await repository.findById(row.id))?.result).toEqual({
          publication: "transport-test",
        });
      } finally {
        await release();
        await worker.close();
        await db.close();
      }
    }, 60_000);
  },
);
