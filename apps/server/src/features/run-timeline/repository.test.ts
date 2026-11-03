import { describe, expect, it } from "vitest";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createRunTimelineRepository } from "./repository.js";

const INSTANCE_ID = "instance-1";
const ROOT_SESSION_ID = "session-1";
const RUN_ID = "run-1";
const CHILD_SESSION_ID = "child-1";
const AT = "2026-11-04T00:00:00.000Z";

function fixture(rows: unknown[] = [], rowCount = rows.length) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query: PostgresQueryRunner["query"] = async (sql, values) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
    return { rowCount, rows };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("时间线只读，不打开任务宿主会话。");
    },
    end: async () => {},
  };
  const repository = createRunTimelineRepository(
    createPersistenceFromRunner(runner),
  );
  return { calls, repository };
}

describe("运行时间线仓储", () => {
  it("按运行 id 取终态并带出根会话，实例谓词由作用域客户端注入", async () => {
    const { calls, repository } = fixture([
      {
        id: RUN_ID,
        session_id: ROOT_SESSION_ID,
        model: "model-x",
        status: "completed",
        stop_reason: "completed",
        error_code: null,
        error_message: null,
        created_at: AT,
        completed_at: AT,
      },
    ]);

    const run = await repository.loadRun(INSTANCE_ID, RUN_ID);

    expect(run).toMatchObject({
      runId: RUN_ID,
      rootSessionId: ROOT_SESSION_ID,
      status: "completed",
      completedAt: AT,
    });
    expect(calls[0]?.sql).toContain("join public.chat_sessions s");
    expect(calls[0]?.sql).toContain("s.instance_id = $2");
    expect(calls[0]?.values).toEqual([RUN_ID, INSTANCE_ID]);
  });

  it("运行不存在或不属于本实例时返回 null", async () => {
    const { repository } = fixture([]);

    expect(await repository.loadRun(INSTANCE_ID, RUN_ID)).toBeNull();
  });

  it("按运行前缀取事件，解析失败的历史行跳过而不拖垮整轮", async () => {
    const { calls, repository } = fixture([
      {
        seq: "1",
        created_at: AT,
        payload: {
          type: "run.started",
          runId: RUN_ID,
          sessionId: ROOT_SESSION_ID,
          conversationId: ROOT_SESSION_ID,
          timestamp: AT,
        },
      },
      {
        seq: "2",
        created_at: AT,
        payload: { type: "unknown-legacy-event", runId: RUN_ID },
      },
    ]);

    const events = await repository.loadEvents(INSTANCE_ID, RUN_ID);

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({ type: "run.started" });
    expect(events[0]?.seq).toBe(1);
    expect(calls[0]?.sql).toContain("starts_with(e.event_key, $1 || '/')");
    expect(calls[0]?.values).toEqual([RUN_ID, INSTANCE_ID]);
  });

  it("子会话索引按派发键前缀取，父会话限定根与实例", async () => {
    const { calls, repository } = fixture([
      {
        child_session_id: CHILD_SESSION_ID,
        parent_tool_call_id: `${RUN_ID}/call-task`,
      },
    ]);

    const sessions = await repository.loadChildSessions(
      INSTANCE_ID,
      ROOT_SESSION_ID,
      RUN_ID,
    );

    expect(sessions).toEqual([
      {
        childSessionId: CHILD_SESSION_ID,
        parentToolCallId: `${RUN_ID}/call-task`,
      },
    ]);
    expect(calls[0]?.sql).toContain("s.root_session_id = $1");
    expect(calls[0]?.sql).toContain(
      "starts_with(s.parent_tool_call_id, $2)",
    );
    expect(calls[0]?.values).toEqual([
      ROOT_SESSION_ID,
      `${RUN_ID}/`,
      INSTANCE_ID,
    ]);
  });

  it("子会话事件按 child-event 前缀取，并按 seq 升序", async () => {
    const { calls, repository } = fixture([
      {
        seq: "3",
        created_at: AT,
        payload: {
          type: "tool.started",
          runId: "child-run",
          toolCallId: "read-1",
          toolName: "Read",
          timestamp: AT,
        },
      },
    ]);

    const events = await repository.loadChildEvents(
      INSTANCE_ID,
      ROOT_SESSION_ID,
      CHILD_SESSION_ID,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(3);
    expect(calls[0]?.sql).toContain("e.root_session_id = $1");
    expect(calls[0]?.sql).toContain("starts_with(e.event_key, $2)");
    expect(calls[0]?.values).toEqual([
      ROOT_SESSION_ID,
      `child-event:${CHILD_SESSION_ID}/`,
      INSTANCE_ID,
    ]);
  });

  it("没有用量落账时返回 null，不拿 0 冒充", async () => {
    const { repository } = fixture([
      {
        input_tokens: "0",
        output_tokens: "0",
        cost_usd: null,
        calls: "0",
      },
    ]);

    expect(await repository.loadUsage(INSTANCE_ID, RUN_ID)).toBeNull();
  });

  it("有用量落账时汇总并保留未上报成本的空值", async () => {
    const { calls, repository } = fixture([
      {
        input_tokens: "120",
        output_tokens: "60",
        cost_usd: null,
        calls: "2",
      },
    ]);

    expect(await repository.loadUsage(INSTANCE_ID, RUN_ID)).toEqual({
      inputTokens: 120,
      outputTokens: 60,
      costUsd: null,
    });
    expect(calls[0]?.sql).toContain("where instance_id = $2");
    expect(calls[0]?.sql).toContain("and run_id = $1");
    expect(calls[0]?.values).toEqual([RUN_ID, INSTANCE_ID]);
  });
});
