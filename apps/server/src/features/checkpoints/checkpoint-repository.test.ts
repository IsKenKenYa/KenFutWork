import { describe, expect, it } from "vitest";

import type { PersistenceService } from "../persistence/types.js";
import {
  type CheckpointRow,
  createCheckpointRepository,
  createInMemoryCheckpointRepository,
} from "./repository.js";

/**
 * 检查点仓储（切片2）。
 *
 * SQL 仓储用**录制型假 persistence** 锁语句形状（`:workspace` 谓词、参数序、
 * snake_case → camelCase 行映射）——与 execution-mode-store.test.ts 同一套路；
 * 真实读写由 checkpoint-repository.integration.test.ts 在真库上覆盖（默认 skip）。
 * 内存实现锁排序、隔离与 getPrevious 的「严格早于」口径。
 */

const row = (overrides: Partial<CheckpointRow> = {}): CheckpointRow => ({
  id: "ck-1",
  workspaceId: "ws-1",
  canvasId: "canvas-1",
  runId: null,
  kind: "turn",
  label: "轮次开始快照",
  shadowCommit: "a".repeat(40),
  filesChanged: 1,
  insertions: 1,
  deletions: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const makeRecordingPersistence = (canned?: Record<string, unknown>) => {
  const statements: Array<{
    sql: string;
    params: readonly unknown[] | undefined;
  }> = [];
  const client = {
    workspaceId: "ws-1",
    query: async (sql: string, params?: readonly unknown[]) => {
      statements.push({ sql, params });
      return canned ? [canned] : [];
    },
    queryOne: async (sql: string, params?: readonly unknown[]) => {
      statements.push({ sql, params });
      return canned ?? null;
    },
    execute: async (sql: string, params?: readonly unknown[]) => {
      statements.push({ sql, params });
      return 1;
    },
  };
  return {
    persistence: {
      forWorkspace: () => client,
    } as unknown as PersistenceService,
    statements,
  };
};

describe("检查点仓储：SQL 形状（录制假 persistence）", () => {
  it("insert 落 public.project_checkpoints，workspace 经 :workspace 绑定", async () => {
    const { persistence, statements } = makeRecordingPersistence();
    await createCheckpointRepository(persistence).insert(row());

    expect(statements).toHaveLength(1);
    const sql = statements[0]?.sql ?? "";
    expect(sql).toContain("insert into public.project_checkpoints");
    expect(sql).toContain(":workspace");
    expect(statements[0]?.params).toEqual([
      "ck-1",
      "canvas-1",
      null,
      "turn",
      "轮次开始快照",
      "a".repeat(40),
      1,
      1,
      0,
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("读回行做 snake_case → camelCase 映射（含 Date → ISO）", async () => {
    const { persistence } = makeRecordingPersistence({
      id: "ck-9",
      workspace_id: "ws-1",
      canvas_id: "c-9",
      run_id: "run-2",
      kind: "restore",
      label: "回滚恢复点",
      shadow_commit: "b".repeat(40),
      files_changed: 3,
      insertions: 10,
      deletions: 4,
      created_at: new Date("2026-01-02T03:04:05Z"),
    });
    const loaded = await createCheckpointRepository(persistence).getById(
      "ws-1",
      "ck-9",
    );
    expect(loaded).toEqual({
      id: "ck-9",
      workspaceId: "ws-1",
      canvasId: "c-9",
      runId: "run-2",
      kind: "restore",
      label: "回滚恢复点",
      shadowCommit: "b".repeat(40),
      filesChanged: 3,
      insertions: 10,
      deletions: 4,
      createdAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("listByCanvas 升序、getPrevious 严格早于，均带工作区谓词", async () => {
    const { persistence, statements } = makeRecordingPersistence();
    const repo = createCheckpointRepository(persistence);

    await repo.listByCanvas("ws-1", "c-1");
    expect(statements[0]?.sql).toContain("workspace_id = :workspace");
    expect(statements[0]?.sql).toContain("order by created_at asc");
    expect(statements[0]?.params).toEqual(["c-1"]);

    await repo.getPrevious("ws-1", "c-1", "2026-01-01T00:00:00.000Z");
    expect(statements[1]?.sql).toContain("workspace_id = :workspace");
    expect(statements[1]?.sql).toContain("created_at < $2");
    expect(statements[1]?.sql).toContain("limit 1");
    expect(statements[1]?.params).toEqual(["c-1", "2026-01-01T00:00:00.000Z"]);
  });
});

describe("检查点仓储：内存实现", () => {
  it("listByCanvas 按 createdAt 升序（与插入顺序无关），画布之间隔离", async () => {
    const repo = createInMemoryCheckpointRepository();
    await repo.insert(
      row({ id: "ck-2", createdAt: "2026-01-01T00:00:01.000Z" }),
    );
    await repo.insert(
      row({ id: "ck-1", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    await repo.insert(
      row({
        id: "ck-3",
        canvasId: "canvas-2",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    const rows = await repo.listByCanvas("ws-1", "canvas-1");
    expect(rows.map((r) => r.id)).toEqual(["ck-1", "ck-2"]);
    expect(await repo.listByCanvas("ws-1", "canvas-2")).toHaveLength(1);
  });

  it("getById 按工作区隔离：外工作区取不到", async () => {
    const repo = createInMemoryCheckpointRepository();
    await repo.insert(row());
    expect(await repo.getById("ws-1", "ck-1")).not.toBeNull();
    expect(await repo.getById("ws-2", "ck-1")).toBeNull();
    expect(await repo.getById("ws-1", "ck-x")).toBeNull();
  });

  it("getPrevious 严格早于：等于该时刻的行不算，取更早里的最近一行", async () => {
    const repo = createInMemoryCheckpointRepository();
    await repo.insert(
      row({ id: "ck-1", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    await repo.insert(
      row({ id: "ck-2", createdAt: "2026-01-01T00:00:01.000Z" }),
    );

    expect(
      (await repo.getPrevious("ws-1", "canvas-1", "2026-01-01T00:00:02.000Z"))
        ?.id,
    ).toBe("ck-2");
    expect(
      (await repo.getPrevious("ws-1", "canvas-1", "2026-01-01T00:00:01.000Z"))
        ?.id,
    ).toBe("ck-1");
    expect(
      await repo.getPrevious("ws-1", "canvas-1", "2026-01-01T00:00:00.000Z"),
    ).toBeNull();
    expect(
      await repo.getPrevious("ws-1", "canvas-1", "2025-12-31T00:00:00.000Z"),
    ).toBeNull();
  });
});
