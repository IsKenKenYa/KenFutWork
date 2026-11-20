import { describe, expect, it } from "vitest";

import type { PersistenceService } from "../persistence/types.js";
import { createExecutionModeStore } from "./execution-mode-store.js";

/**
 * 回归（合并后 GUI 实测发现）：执行模式接口必须**同时接受 thread_id 与会话 id**。
 *
 * 背景：run 路径（WS）带的是服务端内部 thread_id，而画布助手面板的模式选择器手里
 * 只有会话 id（会话列表契约只回 id/title/updatedAt）。此前 SQL 只匹配 `s.thread_id`，
 * 于是面板里切模式必然落空——接口还把「找不到线程」报成「Invalid mode.」，排查时
 * 完全看不出原因（实测：切「计划」被静默回滚成「自主」）。
 *
 * 这里用桩 persistence 记录语句，锁住「两种 id 都参与匹配」这一点；真实读写由
 * `execution-mode-store.integration.test.ts` 在库上覆盖。
 */
function createRecordingPersistence() {
  const statements: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const client = {
    instanceId: "ws-1",
    query: async (sql: string, params?: readonly unknown[]) => {
      statements.push({ sql, ...(params ? { params } : {}) });
      return [] as Record<string, unknown>[];
    },
    queryOne: async () => null,
    execute: async (sql: string, params?: readonly unknown[]) => {
      statements.push({ sql, ...(params ? { params } : {}) });
      return 0;
    },
  };
  const persistence = {
    forInstance: () => client,
  } as unknown as PersistenceService;
  return { persistence, statements };
}

describe("执行模式持久化：入参兼容 thread_id 与会话 id", () => {
  it("lookup 的语句同时按 thread_id 与会话 id 匹配", async () => {
    const { persistence, statements } = createRecordingPersistence();
    const store = createExecutionModeStore(persistence);

    await store.lookup("ws-1", "session-或-thread-id");

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("s.thread_id = $1");
    expect(statements[0]?.sql).toContain("s.id::text = $1");
    expect(statements[0]?.sql).toContain(":instance");
  });

  it("save 的语句同样按两者匹配，且仍带工作区归属校验", async () => {
    const { persistence, statements } = createRecordingPersistence();
    const store = createExecutionModeStore(persistence);

    await store.save("ws-1", "session-或-thread-id", "plan");

    expect(statements).toHaveLength(1);
    const sql = statements[0]?.sql;
    expect(sql).toContain("s.thread_id = $1");
    expect(sql).toContain("s.id::text = $1");
    expect(sql).toContain(":instance");
    expect(statements[0]?.params).toEqual(["session-或-thread-id", "plan"]);
  });

  it("行存在时把持久化模式读回（未知/空值回落 null，由上层落 agent）", async () => {
    const persistence = {
      forInstance: () => ({
        instanceId: "ws-1",
        query: async () => [{ execution_mode: "plan" }],
        queryOne: async () => null,
        execute: async () => 0,
      }),
    } as unknown as PersistenceService;
    const store = createExecutionModeStore(persistence);

    await expect(store.lookup("ws-1", "s1")).resolves.toEqual({
      exists: true,
      mode: "plan",
    });

    const weird = {
      forInstance: () => ({
        instanceId: "ws-1",
        query: async () => [{ execution_mode: "not-a-mode" }],
        queryOne: async () => null,
        execute: async () => 0,
      }),
    } as unknown as PersistenceService;
    await expect(
      createExecutionModeStore(weird).lookup("ws-1", "s1"),
    ).resolves.toEqual({ exists: true, mode: null });
  });
});
