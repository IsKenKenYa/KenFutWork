import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createCheckpointRepository } from "./repository.js";

/**
 * project_checkpoints 仓储的真实库集成（默认 skipped：需要 DATABASE_URL）。
 *
 * 运行：DATABASE_URL=postgresql://… pnpm --filter @kenfutwork/server exec vitest run checkpoint-repository.integration
 *
 * 注意：表 DDL 在切片4 的迁移里落地——切片4 合并前对真库运行会因缺表失败，属预期。
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("project_checkpoints 仓储集成", () => {
  it("insert → 升序读回 → 工作区隔离 → getPrevious 严格早于", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });
    try {
      const repository = createCheckpointRepository(persistence);
      const workspaceId = randomUUID();
      const canvasId = randomUUID();
      const t1 = new Date(Date.now() - 2_000).toISOString();
      const t2 = new Date(Date.now() - 1_000).toISOString();
      const row = (seq: number, createdAt: string) => ({
        id: randomUUID(),
        workspaceId,
        canvasId,
        runId: seq === 1 ? null : "run-1",
        kind: seq === 1 ? ("turn" as const) : ("restore" as const),
        label: `检查点${seq}`,
        shadowCommit: `sha-${seq}`,
        filesChanged: seq,
        insertions: seq,
        deletions: 0,
        createdAt,
      });

      await repository.insert(row(1, t1));
      await repository.insert(row(2, t2));

      const rows = await repository.listByCanvas(workspaceId, canvasId);
      expect(rows.map((r) => r.shadowCommit)).toEqual(["sha-1", "sha-2"]);
      const [first] = rows;
      if (!first) throw new Error("应能读回两行");
      expect(first.runId).toBeNull();

      // 外工作区不可见；本工作区按 id 可取
      expect(await repository.getById(randomUUID(), first.id)).toBeNull();
      expect((await repository.getById(workspaceId, first.id))?.label).toBe(
        "检查点1",
      );

      // getPrevious：严格早于
      expect(
        (await repository.getPrevious(workspaceId, canvasId, t2))?.shadowCommit,
      ).toBe("sha-1");
      expect(
        await repository.getPrevious(workspaceId, canvasId, t1),
      ).toBeNull();
    } finally {
      await persistence.close();
    }
  });
});
