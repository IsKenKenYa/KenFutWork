import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTemporaryPostgres } from "../task-work/test-postgres.js";
import { createPostgresPersistence } from "./providers/postgres.js";

/** 默认跳过；显式打开只创建本测试自己的临时 PG，不使用 DATABASE_URL。 */
describe.skipIf(process.env.KENFUTWORK_TASK_WORK_PG_TEST !== "1")(
  "独占持久会话的真实 Postgres seam",
  () => {
    let database: Awaited<ReturnType<typeof createTemporaryPostgres>>;
    beforeAll(async () => {
      database = await createTemporaryPostgres();
    });
    afterAll(async () => {
      await database?.close();
    });

    it("独占宿主锁阻止第二实例，专用连接不耗尽单连接查询池，重复release后可接任", async () => {
      const first = createPostgresPersistence({
        databaseUrl: database.connectionString,
        maxConnections: 1,
      });
      const second = createPostgresPersistence({
        databaseUrl: database.connectionString,
        maxConnections: 1,
      });
      try {
        const lock = await first.acquireSessionLock(
          "task-work:host:exclusive-proof",
        );
        expect(lock).not.toBeNull();
        expect(await first.queryOne("select 42 as proof")).toEqual({
          proof: 42,
        });
        await expect(
          second.acquireSessionLock("task-work:host:exclusive-proof"),
        ).resolves.toBeNull();
        if (!lock) throw new Error("第一次独占会话必须成功。");
        await Promise.all([lock.release(), lock.release()]);
        const successor = await second.acquireSessionLock(
          "task-work:host:exclusive-proof",
        );
        expect(successor).not.toBeNull();
        await successor?.release();
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    });
  },
);
