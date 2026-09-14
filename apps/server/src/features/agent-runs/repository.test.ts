import { describe, expect, it } from "vitest";

import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createAgentRunRepository } from "./repository.js";

const RUN_ID = "run-1";

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string, values: unknown[]) => FakeResult = () => ({
    rowCount: 0,
    rows: [],
  }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text, values);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text, values) => run(text, values),
        release: () => {},
      };
    },
    async end() {},
  };

  return {
    calls,
    runner,
    sqls: () => calls.map((c) => c.text.replace(/\s+/g, " ").trim()),
  };
}

describe("agent-runs repository（agent_runs，按 run id 定权）", () => {
  it("建运行记录：model 缺省落 NULL", async () => {
    const { calls, runner } = createRunner();

    await createAgentRunRepository(createPersistenceFromRunner(runner)).insert({
      model: null,
      runId: RUN_ID,
      sessionId: "session-1",
      status: "accepted",
      threadId: "thread-1",
    });

    expect(calls[0]?.text.replace(/\s+/g, " ")).toContain(
      "insert into public.agent_runs (id, model, session_id, status, thread_id)",
    );
    expect(calls[0]?.values).toEqual([
      RUN_ID,
      null,
      "session-1",
      "accepted",
      "thread-1",
    ]);
    // agent_runs 无 workspace_id 列：按 run id 定权（run id 由服务端生成）
    expect(calls[0]?.text).not.toContain("workspace_id");
  });

  it("更新只写显式给出且非 undefined 的列", async () => {
    const { calls, runner } = createRunner(() => ({ rowCount: 1, rows: [] }));

    await createAgentRunRepository(
      createPersistenceFromRunner(runner),
    ).updateById(RUN_ID, {
      completed_at: "2026-09-13T00:00:00.000Z",
      error_code: undefined,
      status: "succeeded",
    });

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("set completed_at = $2, status = $3");
    expect(sql).not.toContain("error_code");
    expect(sql).toContain("where id = $1");
    expect(calls[0]?.values).toEqual([
      RUN_ID,
      "2026-09-13T00:00:00.000Z",
      "succeeded",
    ]);
  });

  it("空补丁不下发语句（返回 0 行）", async () => {
    const { calls, runner } = createRunner();
    await expect(
      createAgentRunRepository(createPersistenceFromRunner(runner)).updateById(
        RUN_ID,
        { error_code: undefined },
      ),
    ).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });
});

/**
 * 回归（实测事故）：进程在 run 在飞时被重启/杀掉，没人写终态 —— 行永远停在
 * `running`，客户端永远显示「生成中」（本机复现过一次）。启动期对账把这些孤儿
 * 收敛成 failed，且只碰「启动前创建」的行，绝不误杀本进程新起的 run。
 */
describe("agent_runs 启动期孤儿对账", () => {
  it("只收敛启动前的非终态行，并写入可读原因", async () => {
    const { calls, runner } = createRunner(() => ({ rowCount: 3, rows: [] }));
    const before = new Date("2026-09-15T10:00:00.000Z");
    const count = await createAgentRunRepository(
      createPersistenceFromRunner(runner),
    ).reconcileInterrupted(before, "服务重启，本轮已中断。");

    expect(count).toBe(3);
    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain("completed_at = now()");
    expect(sql).toContain("error_code = 'run_failed'");
    // 只碰非终态 + 启动前创建的行（两条谓词缺一不可）
    expect(sql).toContain("status in ('accepted', 'running')");
    expect(sql).toContain("created_at < $2");
    expect(calls[0]?.values).toEqual([
      "服务重启，本轮已中断。",
      before.toISOString(),
    ]);
  });

  it("没有孤儿时返回 0（启动日志不应报数）", async () => {
    const { runner } = createRunner(() => ({ rowCount: 0, rows: [] }));
    await expect(
      createAgentRunRepository(
        createPersistenceFromRunner(runner),
      ).reconcileInterrupted(new Date(), "x"),
    ).resolves.toBe(0);
  });
});
