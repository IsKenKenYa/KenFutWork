import { describe, expect, it } from "vitest";

import { SqlError, WorkspaceIsolationError } from "./errors.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "./providers/postgres.js";

type QueryCall = { text: string; values: unknown[] };

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

/** 按语句决定结果：控制语句（begin/commit/rollback）也走同一入口。 */
type Responder = (text: string, values: unknown[]) => FakeResult;

const EMPTY: FakeResult = { rowCount: 0, rows: [] };

const emptyResponse: Responder = () => EMPTY;

function alwaysRespond(result: FakeResult): Responder {
  return () => result;
}

function createFakeRunner(respond: Responder = emptyResponse) {
  const calls: QueryCall[] = [];
  let ended = false;
  let releases = 0;

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
        release: () => {
          releases += 1;
        },
      };
    },
    async end() {
      ended = true;
    },
  };

  return {
    calls,
    runner,
    releaseCount: () => releases,
    wasEnded: () => ended,
  };
}

const CONTROL_STATEMENTS = new Set(["begin", "commit", "rollback"]);

/** 剔除事务控制语句后的业务语句。 */
function dataCalls(calls: QueryCall[]) {
  return calls.filter((call) => !CONTROL_STATEMENTS.has(call.text));
}

describe("persistence（自管 Postgres Provider）", () => {
  it("根客户端原样下传参数（系统级语句不绑定工作区）", async () => {
    const fake = createFakeRunner(
      alwaysRespond({ rowCount: 1, rows: [{ id: "p1" }] }),
    );
    const persistence = createPersistenceFromRunner(fake.runner);

    const rows = await persistence.query(
      "select id from projects where id = $1",
      ["p1"],
    );

    expect(rows).toEqual([{ id: "p1" }]);
    expect(fake.calls).toEqual([
      { text: "select id from projects where id = $1", values: ["p1"] },
    ]);
  });

  it("forWorkspace 把 :workspace 重写为末位参数占位符", async () => {
    const fake = createFakeRunner();
    const persistence = createPersistenceFromRunner(fake.runner);

    await persistence
      .forWorkspace("ws-1")
      .query(
        "select id from projects where workspace_id = :workspace and id = $1",
        ["prj"],
      );

    expect(fake.calls).toEqual([
      {
        text: "select id from projects where workspace_id = $2 and id = $1",
        values: ["prj", "ws-1"],
      },
    ]);
  });

  it("多处 :workspace 复用同一占位符，工作区只绑定一次", async () => {
    const fake = createFakeRunner();
    const persistence = createPersistenceFromRunner(fake.runner);

    await persistence
      .forWorkspace("ws-2")
      .execute(
        "delete from canvases where workspace_id = :workspace and project_id in (select id from projects where workspace_id = :workspace)",
      );

    expect(fake.calls).toEqual([
      {
        text: "delete from canvases where workspace_id = $1 and project_id in (select id from projects where workspace_id = $1)",
        values: ["ws-2"],
      },
    ]);
  });

  it("漏写 :workspace 谓词的 workspace 语句立即失败，且不下发查询", async () => {
    const fake = createFakeRunner();
    const persistence = createPersistenceFromRunner(fake.runner);
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

    expect(fake.calls).toHaveLength(0);
  });

  it("不同工作区各自绑定自己的 id（跨工作区参数不串）", async () => {
    const fake = createFakeRunner();
    const persistence = createPersistenceFromRunner(fake.runner);
    const sql = "select id from projects where workspace_id = :workspace";

    await persistence.forWorkspace("ws-a").query(sql);
    await persistence.forWorkspace("ws-b").query(sql);

    expect(fake.calls.map((call) => call.values)).toEqual([["ws-a"], ["ws-b"]]);
  });

  it("queryOne 空结果返回 null，命中返回首行", async () => {
    const empty = createPersistenceFromRunner(createFakeRunner().runner);
    await expect(empty.queryOne("select 1")).resolves.toBeNull();

    const hit = createPersistenceFromRunner(
      createFakeRunner(alwaysRespond({ rowCount: 1, rows: [{ ok: 1 }] }))
        .runner,
    );
    await expect(hit.queryOne("select 1")).resolves.toEqual({ ok: 1 });
  });

  it("execute 返回受影响行数，驱动未给 rowCount 时归零", async () => {
    const withCount = createPersistenceFromRunner(
      createFakeRunner(alwaysRespond({ rowCount: 3, rows: [] })).runner,
    );
    await expect(
      withCount.execute("update projects set name = $1", ["x"]),
    ).resolves.toBe(3);

    const withoutCount = createPersistenceFromRunner(
      createFakeRunner(alwaysRespond({ rowCount: null, rows: [] })).runner,
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
      createFakeRunner(alwaysRespond(driverError)).runner,
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
      async acquire() {
        throw new Error("should not acquire");
      },
      async end() {},
    });

    await expect(persistence.query("select 1")).rejects.toBeInstanceOf(
      SqlError,
    );
  });

  it("ping 下发连通性探针，close 结束 runner", async () => {
    const fake = createFakeRunner(
      alwaysRespond({ rowCount: 1, rows: [{ ok: 1 }] }),
    );
    const persistence = createPersistenceFromRunner(fake.runner);

    await persistence.ping();
    expect(fake.calls[0]?.text).toContain("select 1");

    await persistence.close();
    expect(fake.wasEnded()).toBe(true);
  });
});

describe("persistence 事务", () => {
  it("成功时 begin→commit 并释放连接，回调返回值透传", async () => {
    const fake = createFakeRunner((text) =>
      text.startsWith("insert") ? { rowCount: 1, rows: [{ id: "p1" }] } : EMPTY,
    );
    const persistence = createPersistenceFromRunner(fake.runner);

    const created = await persistence.transaction(async (tx) => {
      const row = await tx.queryOne<{ id: string }>(
        "insert into projects (name) values ($1) returning id",
        ["a"],
      );
      return row?.id;
    });

    expect(created).toBe("p1");
    expect(fake.calls.map((call) => call.text)).toEqual([
      "begin",
      "insert into projects (name) values ($1) returning id",
      "commit",
    ]);
    expect(fake.releaseCount()).toBe(1);
  });

  it("抛错时回滚、原样上抛，且连接仍被释放", async () => {
    const boom = new Error("业务校验失败");
    const fake = createFakeRunner();
    const persistence = createPersistenceFromRunner(fake.runner);

    await expect(
      persistence.transaction(async (tx) => {
        await tx.execute("update projects set name = $1", ["b"]);
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(fake.calls.map((call) => call.text)).toEqual([
      "begin",
      "update projects set name = $1",
      "rollback",
    ]);
    expect(fake.releaseCount()).toBe(1);
  });

  it("事务内语句的驱动错误归一为 SqlError 并触发回滚", async () => {
    const driverError = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const fake = createFakeRunner((text) =>
      text.startsWith("insert") ? driverError : EMPTY,
    );
    const persistence = createPersistenceFromRunner(fake.runner);

    const error = await persistence
      .transaction((tx) => tx.execute("insert into projects default values"))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SqlError);
    expect(error).toMatchObject({ code: "23505" });
    expect(fake.calls.map((call) => call.text)).toEqual([
      "begin",
      "insert into projects default values",
      "rollback",
    ]);
    expect(fake.releaseCount()).toBe(1);
  });

  it("回滚本身失败时不覆盖原始错误，连接仍被释放", async () => {
    const original = new Error("原始错误");
    const fake = createFakeRunner((text) =>
      text === "rollback" ? new Error("rollback failed") : EMPTY,
    );
    const persistence = createPersistenceFromRunner(fake.runner);

    await expect(
      persistence.transaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(fake.releaseCount()).toBe(1);
  });

  it("事务内 forWorkspace 仍是隔离客户端（漏写 :workspace 即失败）", async () => {
    const fake = createFakeRunner();
    const persistence = createPersistenceFromRunner(fake.runner);

    await expect(
      persistence.transaction((tx) =>
        tx.forWorkspace("ws-1").query("select 1"),
      ),
    ).rejects.toBeInstanceOf(WorkspaceIsolationError);
    expect(dataCalls(fake.calls)).toHaveLength(0);
    expect(fake.releaseCount()).toBe(1);
  });

  it("事务内 forWorkspace 绑定工作区并与业务参数共存", async () => {
    const fake = createFakeRunner();
    const persistence = createPersistenceFromRunner(fake.runner);

    await persistence.transaction((tx) =>
      tx
        .forWorkspace("ws-9")
        .execute(
          "delete from projects where workspace_id = :workspace and id = $1",
          ["p1"],
        ),
    );

    expect(dataCalls(fake.calls)).toEqual([
      {
        text: "delete from projects where workspace_id = $2 and id = $1",
        values: ["p1", "ws-9"],
      },
    ]);
  });
});
