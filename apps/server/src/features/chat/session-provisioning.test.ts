import { describe, expect, it } from "vitest";

import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createChatRepository } from "./repository.js";

/**
 * SQL 形状单测：真库集成测覆盖行为，这里锁住**语句本身**的两个易错点——
 * ① 带标题/不带标题两个变体的占位符位置不同（写死 $5 会让无标题路径指向不存在的参数，
 *    实测报 `could not determine data type of parameter $4`）；
 * ② `insert … select` 形状下 PG 不反推参数类型，参数必须显式 cast。
 */
type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRecordingRunner(handler: (text: string) => FakeResult) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let inTransaction = false;

  const runner: PostgresQueryRunner = {
    async acquire() {
      return {
        query: async (text: string, values?: unknown[]) => {
          calls.push({ text, values: (values ?? []) as unknown[] });
          if (inTransaction && text.trim().toLowerCase() === "commit") {
            inTransaction = false;
          }
          const result = handler(text);
          if (result instanceof Error) {
            throw result;
          }
          return result;
        },
        release: () => {},
      };
    },
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values: (values ?? []) as unknown[] });
      if (text.trim().toLowerCase() === "begin") {
        inTransaction = true;
      }
      if (inTransaction && text.trim().toLowerCase() === "commit") {
        inTransaction = false;
      }
      const result = handler(text);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    async acquireSession() {
      throw new Error("此查询夹具不提供真实执行宿主会话。");
    },
    async end() {},
  };

  return { calls, runner };
}

const WORKSPACE_ID = "00000000-0000-0000-0000-00000000000a";
const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const CANVAS_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";

function insertSql(calls: Array<{ text: string }>) {
  const call = calls.find((c) =>
    c.text.includes("insert into public.chat_sessions"),
  );
  return (call?.text ?? "").replace(/\s+/g, " ").trim();
}

describe("chat repository：按 id 供给会话（SQL 形状）", () => {
  it("带标题：参数显式 cast，画布占位符为 $5", async () => {
    const { calls, runner } = createRecordingRunner((text) =>
      text.includes("insert into public.chat_sessions")
        ? { rowCount: 1, rows: [{ id: SESSION_ID, thread_id: "t1" }] }
        : { rowCount: 1, rows: [] },
    );

    await createChatRepository(createPersistenceFromRunner(runner))
      .ensureSessionWithId(WORKSPACE_ID, {
        canvasId: CANVAS_ID,
        sessionId: SESSION_ID,
        threadId: "t1",
        title: "标题",
        createdByClientId: USER_ID,
      })
      .catch(() => null);

    const sql = insertSql(calls);
    expect(sql).toContain("$1::uuid");
    expect(sql).toContain("$2::uuid");
    expect(sql).toContain("$3::text");
    expect(sql).toContain("$4::text");
    expect(sql).toContain("c.id = $5::uuid");
  });

  it("不带标题：占位符随参数个数前移（画布是 $4，不写死 $5）", async () => {
    const { calls, runner } = createRecordingRunner((text) =>
      text.includes("insert into public.chat_sessions")
        ? { rowCount: 1, rows: [{ id: SESSION_ID, thread_id: "t1" }] }
        : { rowCount: 1, rows: [] },
    );

    await createChatRepository(createPersistenceFromRunner(runner))
      .ensureSessionWithId(WORKSPACE_ID, {
        canvasId: CANVAS_ID,
        sessionId: SESSION_ID,
        threadId: "t1",
        createdByClientId: USER_ID,
      })
      .catch(() => null);

    const sql = insertSql(calls);
    expect(sql).not.toContain("title");
    expect(sql).toContain("c.id = $4::uuid");
    // $5 只应出现在工作区谓词上（客户端的 `:instance` 标记永远绑定为最后一个参数），
    // 绝不能是画布比较——写死 $5 就是本次修复的那个错位
    expect(sql).not.toContain("c.id = $5");
  });

  it("插入冲突（0 行）→ 回读既有行；缺失 → null", async () => {
    const existing = createRecordingRunner((text) => {
      if (text.includes("insert into public.chat_sessions")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("select s.id, s.thread_id")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: SESSION_ID,
              thread_id: "thread_existing",
              canvas_id: CANVAS_ID,
              project_id: "visual-project",
              mode: "design",
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });

    const row = await createChatRepository(
      createPersistenceFromRunner(existing.runner),
    ).ensureSessionWithId(WORKSPACE_ID, {
      canvasId: CANVAS_ID,
      sessionId: SESSION_ID,
      threadId: "thread_new",
      createdByClientId: USER_ID,
    });
    expect(row?.thread_id).toBe("thread_existing");

    const missing = createRecordingRunner(() => ({ rowCount: 0, rows: [] }));
    const none = await createChatRepository(
      createPersistenceFromRunner(missing.runner),
    ).ensureSessionWithId(WORKSPACE_ID, {
      canvasId: CANVAS_ID,
      sessionId: SESSION_ID,
      threadId: "thread_new",
      createdByClientId: USER_ID,
    });
    expect(none).toBeNull();
  });

  it("既有行没有线程 → 绑定传入线程（多轮方能续同一 thread）", async () => {
    const { calls, runner } = createRecordingRunner((text) => {
      if (text.includes("insert into public.chat_sessions")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("select s.id, s.thread_id")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: SESSION_ID,
              thread_id: null,
              canvas_id: CANVAS_ID,
              project_id: "visual-project",
              mode: "design",
            },
          ],
        };
      }
      if (text.includes("set thread_id = $1::text")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: SESSION_ID,
              thread_id: "thread_new",
              canvas_id: CANVAS_ID,
              project_id: "visual-project",
              mode: "design",
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });

    const row = await createChatRepository(
      createPersistenceFromRunner(runner),
    ).ensureSessionWithId(WORKSPACE_ID, {
      canvasId: CANVAS_ID,
      sessionId: SESSION_ID,
      threadId: "thread_new",
      createdByClientId: USER_ID,
    });

    expect(row?.thread_id).toBe("thread_new");
    expect(calls.some((c) => c.text.includes("set thread_id = $1::text"))).toBe(
      true,
    );
  });
});
