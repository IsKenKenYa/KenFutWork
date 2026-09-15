import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createAccountRepository } from "./repository.js";
import { createAuthService } from "./service.js";

/**
 * 自管认证真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 *
 * 为什么必须有真库覆盖：单元测试断言的是 SQL 文本与分支，**证明不了**表存在、类型对得上、
 * 事务真的提交、`update … returning` 的多表 JOIN 写法在 Postgres 里成立。认证是登录口，
 * 出错即全员登不进。
 *
 * 运行：DATABASE_URL=postgresql://postgres:…@127.0.0.1:54322/postgres \
 *       pnpm --filter @kenfutwork/server exec vitest run auth.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("自管认证真实库集成", () => {
  it("注册 → 登录 → 会话校验 → 登出 全链路在真库成立", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });
    const email = `auth-probe-${Date.now().toString(36)}@test.kenfutwork.com`;

    try {
      const repository = createAccountRepository(persistence);
      const auth = createAuthService({ repository, sessionTtlSeconds: 60 });

      // 1) 注册：账号 + 凭据 + 会话都在一个事务里落地
      const registered = await auth.register({
        displayName: "Auth Probe",
        email,
        password: "correct horse battery",
      });
      expect(registered.user.email).toBe(email);
      expect(registered.token).toBeTruthy();

      // 2) 会话可校验（走 `update … from public.accounts` 的单语句取数）
      await expect(
        auth.resolveSession(registered.token),
      ).resolves.toMatchObject({
        email,
        id: registered.user.id,
      });

      // 3) 登出后同一令牌失效
      await auth.logout(registered.token);
      await expect(auth.resolveSession(registered.token)).resolves.toBeNull();

      // 4) 重新登录：口令校验读的是真库里的 scrypt 哈希
      const loggedIn = await auth.login({
        email: email.toUpperCase(), // 邮箱大小写不敏感
        password: "correct horse battery",
      });
      expect(loggedIn.user.id).toBe(registered.user.id);
      expect(loggedIn.token).not.toBe(registered.token);

      // 5) 错误口令被拒，且不签发新会话
      await expect(
        auth.login({ email, password: "wrong password" }),
      ).rejects.toMatchObject({ code: "invalid_credentials", statusCode: 401 });

      // 6) 重复注册同一邮箱被拒
      await expect(
        auth.register({ email: email.toUpperCase(), password: "another one" }),
      ).rejects.toMatchObject({ code: "email_taken", statusCode: 409 });

      // 7) 过期会话不算命中（把 expires_at 改到过去）
      await persistence.execute(
        "update public.account_sessions set expires_at = now() - interval '1 second' where user_id = $1",
        [registered.user.id],
      );
      await expect(auth.resolveSession(loggedIn.token)).resolves.toBeNull();

      // 8) 清理过期会话可反复调用
      const removed = await repository.deleteExpiredSessions(new Date());
      expect(removed).toBeGreaterThanOrEqual(1);

      // 9) 口令哈希不落明文
      const stored = await persistence.queryOne<{ password_hash: string }>(
        "select password_hash from public.account_credentials where user_id = $1",
        [registered.user.id],
      );
      expect(stored?.password_hash.startsWith("scrypt$")).toBe(true);
      expect(stored?.password_hash).not.toContain("correct horse battery");
    } finally {
      // account_credentials / account_sessions 对 public.accounts 是 ON DELETE CASCADE
      await persistence.query(
        "delete from public.accounts where lower(email::text) = lower($1)",
        [email],
      );
      await persistence.close();
    }
  });

  it("注销账号级联清理凭据与会话（不留孤儿行）", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });
    const email = `auth-cascade-${Date.now().toString(36)}@test.kenfutwork.com`;

    try {
      const auth = createAuthService({
        repository: createAccountRepository(persistence),
      });
      const session = await auth.register({ email, password: "cascade check" });
      const userId = session.user.id;

      await persistence.query("delete from public.accounts where id = $1", [
        userId,
      ]);

      const credentials = await persistence.queryOne<{ n: number }>(
        "select count(*)::int as n from public.account_credentials where user_id = $1",
        [userId],
      );
      const sessions = await persistence.queryOne<{ n: number }>(
        "select count(*)::int as n from public.account_sessions where user_id = $1",
        [userId],
      );
      expect(credentials?.n).toBe(0);
      expect(sessions?.n).toBe(0);
    } finally {
      await persistence.query(
        "delete from public.accounts where lower(email::text) = lower($1)",
        [email],
      );
      await persistence.close();
    }
  });
});
