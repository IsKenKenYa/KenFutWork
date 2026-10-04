import { describe, expect, it } from "vitest";

import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import {
  createAccountRepository,
  EmailTakenError,
  hashSessionToken,
} from "./repository.js";

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string) => FakeResult = () => ({ rowCount: 0, rows: [] }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text);
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
    async acquireSession() { throw new Error("此查询夹具不提供真实执行宿主会话。"); },
    async end() {},
  };

  return {
    calls,
    runner,
    sqls: () => calls.map((c) => c.text.replace(/\s+/g, " ").trim()),
  };
}

describe("auth repository：账号读取", () => {
  it("按邮箱取账号用 lower(email) 精确匹配（不区分大小写、无列表扫描）", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [
        {
          display_name: "Pro Tester",
          email: "pro@test.kenfutwork.com",
          password_hash: "scrypt$...",
          user_id: "user-1",
        },
      ],
    }));

    const account = await createAccountRepository(
      createPersistenceFromRunner(runner),
    ).findAccountByEmail("Pro@Test.KenFutWork.com");

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("from public.accounts u");
    expect(sql).toContain(
      "join public.account_credentials c on c.user_id = u.id",
    );
    expect(sql).toContain("where lower(u.email::text) = lower($1)");
    expect(sql).not.toContain("select *");
    expect(calls[0]?.values).toEqual(["Pro@Test.KenFutWork.com"]);
    expect(account?.user_id).toBe("user-1");
  });

  it("未命中返回 null", async () => {
    const { runner } = createRunner();
    await expect(
      createAccountRepository(
        createPersistenceFromRunner(runner),
      ).findAccountByEmail("nobody@test.kenfutwork.com"),
    ).resolves.toBeNull();
  });
});

describe("auth repository：建账号（同一事务）", () => {
  it("先查重、再插账号与凭据，全部在一个事务里", async () => {
    const { calls, runner } = createRunner((text) => {
      if (text.includes("select id from public.accounts")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("insert into public.accounts")) {
        return { rowCount: 1, rows: [{ id: "user-9" }] };
      }
      return { rowCount: 1, rows: [] };
    });

    const userId = await createAccountRepository(
      createPersistenceFromRunner(runner),
    ).createAccount({
      displayName: "New User",
      email: "new@test.kenfutwork.com",
      passwordHash: "scrypt$hash",
    });

    expect(userId).toBe("user-9");
    const sqls = calls.map((c) => c.text.replace(/\s+/g, " ").trim());
    expect(sqls[0]).toBe("begin");
    expect(sqls).toContain("commit");
    expect(sqls.some((s) => s.includes("insert into public.accounts"))).toBe(
      true,
    );
    expect(
      sqls.some((s) => s.includes("insert into public.account_credentials")),
    ).toBe(true);
    // 插账号时把 display_name 写进 raw_user_meta_data（与既有 viewer 引导同源）
    const insertAccount = calls.find((c) =>
      c.text.includes("insert into public.accounts"),
    );
    expect(insertAccount?.text.replace(/\s+/g, " ")).toContain(
      "jsonb_build_object('display_name', $2::text)",
    );
  });

  it("邮箱已存在 → 抛 EmailTakenError 且回滚（不插任何行）", async () => {
    const { calls, runner } = createRunner((text) =>
      text.includes("select id from public.accounts")
        ? { rowCount: 1, rows: [{ id: "user-1" }] }
        : { rowCount: 0, rows: [] },
    );

    await expect(
      createAccountRepository(
        createPersistenceFromRunner(runner),
      ).createAccount({
        displayName: null,
        email: "taken@test.kenfutwork.com",
        passwordHash: "scrypt$hash",
      }),
    ).rejects.toBeInstanceOf(EmailTakenError);

    const sqls = calls.map((c) => c.text.replace(/\s+/g, " ").trim());
    expect(sqls).toContain("rollback");
    expect(sqls.some((s) => s.startsWith("insert into public.accounts"))).toBe(
      false,
    );
    expect(sqls.some((s) => s.includes("account_credentials"))).toBe(false);
  });
});

describe("auth repository：会话", () => {
  it("按令牌哈希查会话：单语句刷新 last_used_at 并同时取回账号", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [
        {
          email: "pro@test.kenfutwork.com",
          expires_at: "2026-10-13T00:00:00.000Z",
          raw_user_meta_data: {},
          user_id: "user-1",
        },
      ],
    }));

    const session = await createAccountRepository(
      createPersistenceFromRunner(runner),
    ).findSessionByTokenHash(hashSessionToken("token-1"));

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain(
      "update public.account_sessions s set last_used_at = now()",
    );
    expect(sql).toContain("from public.accounts u");
    expect(sql).toContain("where s.token_hash = $1");
    // 过期会话不算命中：过期判断必须落在语句里（不能靠应用层比较）
    expect(sql).toContain("s.expires_at > now()");
    expect(calls[0]?.values).toEqual([hashSessionToken("token-1")]);
    expect(session?.user_id).toBe("user-1");
  });

  it("任何查询都不按明文令牌匹配（只按哈希）", async () => {
    // insert 需要返回行，故给 runner 一个最小响应
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [{ id: "session-1" }],
    }));
    const repository = createAccountRepository(
      createPersistenceFromRunner(runner),
    );

    await repository.createSession({
      expiresAt: new Date("2026-10-13T00:00:00.000Z"),
      tokenHash: hashSessionToken("token-1"),
      userId: "user-1",
    });
    await repository.deleteSession(hashSessionToken("token-1"));

    for (const call of calls) {
      expect(call.values).not.toContain("token-1");
    }
    expect(calls[0]?.text.replace(/\s+/g, " ")).toContain(
      "insert into public.account_sessions",
    );
    expect(calls.at(-1)?.text.replace(/\s+/g, " ")).toContain(
      "delete from public.account_sessions where token_hash = $1",
    );
  });

  it("清理过期会话按 expires_at 谓词（可反复调用）", async () => {
    const { calls, runner } = createRunner(() => ({ rowCount: 3, rows: [] }));
    const now = new Date("2026-09-14T00:00:00.000Z");

    const removed = await createAccountRepository(
      createPersistenceFromRunner(runner),
    ).deleteExpiredSessions(now);

    expect(removed).toBe(3);
    expect(calls[0]?.text.replace(/\s+/g, " ").trim()).toBe(
      "delete from public.account_sessions where expires_at <= $1",
    );
    expect(calls[0]?.values).toEqual([now]);
  });

  it("重置口令是 upsert（种子脚本与改密共用一条语句）", async () => {
    const { calls, runner } = createRunner(() => ({ rowCount: 1, rows: [] }));

    await createAccountRepository(
      createPersistenceFromRunner(runner),
    ).setPasswordHash("user-1", "scrypt$new");

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("insert into public.account_credentials");
    expect(sql).toContain("on conflict (user_id) do update set password_hash");
    expect(calls[0]?.values).toEqual(["user-1", "scrypt$new"]);
  });
});

describe("auth repository：本机账号（local-trust，无口令）", () => {
  it("先加事务级建议锁再取/建，保证并发首请求不各建一个账号", async () => {
    const { calls, runner } = createRunner((text) =>
      text.includes("select id, email")
        ? { rowCount: 0, rows: [] }
        : {
            rowCount: 1,
            rows: [{ email: "local@kenfutwork.local", id: "u-1" }],
          },
    );

    const account = await createAccountRepository(
      createPersistenceFromRunner(runner),
    ).ensurePasswordlessAccount({
      displayName: "本机用户",
      email: "local@kenfutwork.local",
    });

    expect(account).toEqual({ email: "local@kenfutwork.local", id: "u-1" });
    const sqls = calls.map((c) => c.text.replace(/\s+/g, " ").trim());
    expect(sqls[0]).toBe("begin");
    // 锁必须在查询之前，且在事务内（pg_advisory_xact_lock 随事务释放）
    expect(sqls[1]).toContain("pg_advisory_xact_lock");
    expect(sqls[2]).toContain("select id, email");
    expect(sqls.some((s) => s.includes("insert into public.accounts"))).toBe(
      true,
    );
    // 不写口令凭据：本形态不走口令登录
    expect(sqls.some((s) => s.includes("account_credentials"))).toBe(false);
    expect(sqls).toContain("commit");
  });

  it("账号已存在 → 不插入，直接返回既有行（幂等）", async () => {
    const { calls, runner } = createRunner((text) =>
      text.includes("select id, email")
        ? {
            rowCount: 1,
            rows: [{ email: "local@kenfutwork.local", id: "u-9" }],
          }
        : { rowCount: 0, rows: [] },
    );

    const account = await createAccountRepository(
      createPersistenceFromRunner(runner),
    ).ensurePasswordlessAccount({
      displayName: "本机用户",
      email: "local@kenfutwork.local",
    });

    expect(account.id).toBe("u-9");
    expect(
      calls.some((c) => c.text.includes("insert into public.accounts")),
    ).toBe(false);
  });
});
