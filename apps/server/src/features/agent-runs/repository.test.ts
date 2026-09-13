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
