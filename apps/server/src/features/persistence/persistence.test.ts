import { describe, expect, it } from "vitest";

import { SqlError, WorkspaceIsolationError } from "./errors.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "./providers/postgres.js";

type QueryCall = { text: string; values: unknown[] };

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createFakeRunner(results: FakeResult[] = []) {
  const calls: QueryCall[] = [];
  const queue = [...results];
  let ended = false;

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      calls.push({ text, values });
      const next = queue.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next ?? { rowCount: 0, rows: [] };
    },
    async end() {
      ended = true;
    },
  };

  return { calls, runner, wasEnded: () => ended };
}

describe("persistence（自管 Postgres Provider）", () => {
  it("根客户端原样下传参数（系统级语句不绑定工作区）", async () => {
    const { calls, runner } = createFakeRunner([
      { rowCount: 1, rows: [{ id: "p1" }] },
    ]);
    const persistence = createPersistenceFromRunner(runner);

    const rows = await persistence.query(
      "select id from projects where id = $1",
      ["p1"],
    );

    expect(rows).toEqual([{ id: "p1" }]);
    expect(calls).toEqual([
      { text: "select id from projects where id = $1", values: ["p1"] },
    ]);
  });

  it("forWorkspace 把 :workspace 重写为末位参数占位符", async () => {
    const { calls, runner } = createFakeRunner([
      { rowCount: 0, rows: [{ id: "prj" }] },
    ]);
    const persistence = createPersistenceFromRunner(runner);

    await persistence
      .forWorkspace("ws-1")
      .query(
        "select id from projects where workspace_id = :workspace and id = $1",
        ["prj"],
      );

    expect(calls).toEqual([
      {
        text: "select id from projects where workspace_id = $2 and id = $1",
        values: ["prj", "ws-1"],
      },
    ]);
  });

  it("多处 :workspace 复用同一占位符，工作区只绑定一次", async () => {
    const { calls, runner } = createFakeRunner();
    const persistence = createPersistenceFromRunner(runner);

    await persistence
      .forWorkspace("ws-2")
      .execute(
        "delete from canvases where workspace_id = :workspace and project_id in (select id from projects where workspace_id = :workspace)",
      );

    expect(calls).toEqual([
      {
        text: "delete from canvases where workspace_id = $1 and project_id in (select id from projects where workspace_id = $1)",
        values: ["ws-2"],
      },
    ]);
  });

  it("漏写 :workspace 谓词的 workspace 语句立即失败，且不下发查询", async () => {
    const { calls, runner } = createFakeRunner();
    const persistence = createPersistenceFromRunner(runner);
    const scoped = persistence.forWorkspace("ws-1");

    await expect(
      scoped.query("select id from projects where id = $1", ["prj"]),
    ).rejects.toBeInstanceOf(WorkspaceIsolationError);
    await expect(
      scoped.queryOne("select id from projects where id = $1", ["prj"]),
    ).rejects.toBeInstanceOf(WorkspaceIsolationError);
    await expect(
      scoped.execute("delete from projects where id = $1", ["prj"]),
    ).rejects.toBeInstanceOf(WorkspaceIsolationError);

    expect(calls).toHaveLength(0);
  });

  it("不同工作区各自绑定自己的 id（跨工作区参数不串）", async () => {
    const { calls, runner } = createFakeRunner();
    const persistence = createPersistenceFromRunner(runner);
    const sql = "select id from projects where workspace_id = :workspace";

    await persistence.forWorkspace("ws-a").query(sql);
    await persistence.forWorkspace("ws-b").query(sql);

    expect(calls.map((call) => call.values)).toEqual([["ws-a"], ["ws-b"]]);
    expect(persistence.forWorkspace("ws-c").workspaceId).toBe("ws-c");
  });

  it("queryOne 空结果返回 null，命中返回首行", async () => {
    const empty = createPersistenceFromRunner(createFakeRunner().runner);
    await expect(empty.queryOne("select 1")).resolves.toBeNull();

    const hit = createPersistenceFromRunner(
      createFakeRunner([{ rowCount: 1, rows: [{ ok: 1 }] }]).runner,
    );
    await expect(hit.queryOne("select 1")).resolves.toEqual({ ok: 1 });
  });

  it("execute 返回受影响行数，驱动未给 rowCount 时归零", async () => {
    const withCount = createPersistenceFromRunner(
      createFakeRunner([{ rowCount: 3, rows: [] }]).runner,
    );
    await expect(
      withCount.execute("update projects set name = $1", ["x"]),
    ).resolves.toBe(3);

    const withoutCount = createPersistenceFromRunner(
      createFakeRunner([{ rowCount: null, rows: [] }]).runner,
    );
    await expect(
      withoutCount.execute("update projects set name = $1", ["x"]),
    ).resolves.toBe(0);
  });

  it("驱动错误归一化为 SqlError 并保留判重字段", async () => {
    const driverError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "projects_slug_key",
      detail: "Key (slug)=(a) already exists.",
    });
    const persistence = createPersistenceFromRunner(
      createFakeRunner([driverError]).runner,
    );

    const error = await persistence
      .query("insert into projects (slug) values ($1)", ["a"])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SqlError);
    expect(error).toMatchObject({
      code: "23505",
      constraint: "projects_slug_key",
      message: "duplicate key",
    });
  });

  it("非 Error 抛出物也归一化为 SqlError", async () => {
    const persistence = createPersistenceFromRunner({
      async query() {
        throw "boom";
      },
      async end() {},
    });

    await expect(persistence.query("select 1")).rejects.toBeInstanceOf(
      SqlError,
    );
  });

  it("ping 下发连通性探针，close 结束 runner", async () => {
    const fake = createFakeRunner([{ rowCount: 1, rows: [{ ok: 1 }] }]);
    const persistence = createPersistenceFromRunner(fake.runner);

    await persistence.ping();
    expect(fake.calls[0]?.text).toContain("select 1");

    await persistence.close();
    expect(fake.wasEnded()).toBe(true);
  });
});
