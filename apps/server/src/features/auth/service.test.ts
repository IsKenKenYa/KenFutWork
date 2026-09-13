import { describe, expect, it } from "vitest";

import { hashPassword } from "./password.js";
import {
  type AccountRecord,
  type AccountRepository,
  EmailTakenError,
  hashSessionToken,
} from "./repository.js";
import { AuthError, createAuthService, parseBearerToken } from "./service.js";

const EMAIL = "Pro@Test.Loomic.com";
const USER_ID = "user-1";

function createFakeRepository(overrides: Partial<AccountRepository> = {}) {
  const sessions: Array<{
    expiresAt: Date;
    tokenHash: string;
    userId: string;
  }> = [];
  const deleted: string[] = [];

  const repository: AccountRepository = {
    async createAccount() {
      return USER_ID;
    },
    async createSession(input) {
      sessions.push(input);
      return "session-1";
    },
    async deleteExpiredSessions() {
      return 0;
    },
    async deleteSession(tokenHash) {
      deleted.push(tokenHash);
      return 1;
    },
    async findAccountByEmail() {
      return null;
    },
    async findSessionByTokenHash() {
      return null;
    },
    async setPasswordHash() {
      return 1;
    },
    ...overrides,
  };

  return { deleted, repository, sessions };
}

async function accountWith(
  password: string,
  overrides: Partial<AccountRecord> = {},
): Promise<AccountRecord> {
  return {
    display_name: "Pro Tester",
    email: EMAIL,
    password_hash: await hashPassword(password),
    user_id: USER_ID,
    ...overrides,
  };
}

describe("自管认证服务：注册", () => {
  it("注册成功即签发会话；邮箱归一为小写、口令落库为哈希（不存明文）", async () => {
    const created: Array<{
      displayName: string | null;
      email: string;
      passwordHash: string;
    }> = [];
    const { repository, sessions } = createFakeRepository({
      async createAccount(input) {
        created.push(input);
        return USER_ID;
      },
    });
    const auth = createAuthService({ repository, sessionTtlSeconds: 3600 });

    const session = await auth.register({
      displayName: "Pro Tester",
      email: EMAIL,
      password: "correct horse battery",
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.email).toBe("pro@test.loomic.com");
    expect(created[0]?.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(created[0]?.passwordHash).not.toContain("correct horse battery");
    expect(created[0]?.displayName).toBe("Pro Tester");

    expect(session.user.email).toBe("pro@test.loomic.com");
    expect(session.user.id).toBe(USER_ID);
    expect(session.user.accessToken).toBe(session.token);
    expect(session.user.userMetadata).toEqual({ display_name: "Pro Tester" });

    // 库里只该出现令牌的哈希
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).toBe(hashSessionToken(session.token));
    expect(sessions[0]?.tokenHash).not.toBe(session.token);
  });

  it("口令过短 / 邮箱不合法 → 400，且不触发落库", async () => {
    let called = 0;
    const { repository } = createFakeRepository({
      async createAccount() {
        called += 1;
        return USER_ID;
      },
    });
    const auth = createAuthService({ repository });

    await expect(
      auth.register({ email: "a@b.com", password: "short" }),
    ).rejects.toMatchObject({ code: "invalid_input", statusCode: 400 });
    await expect(
      auth.register({ email: "not-an-email", password: "long-enough-1" }),
    ).rejects.toMatchObject({ code: "invalid_input", statusCode: 400 });
    expect(called).toBe(0);
  });

  it("邮箱已存在 → 409", async () => {
    const { repository } = createFakeRepository({
      async createAccount() {
        throw new EmailTakenError();
      },
    });
    const auth = createAuthService({ repository });

    await expect(
      auth.register({ email: "a@b.com", password: "long-enough-1" }),
    ).rejects.toMatchObject({ code: "email_taken", statusCode: 409 });
  });
});

describe("自管认证服务：登录", () => {
  it("口令正确即签发新会话", async () => {
    const account = await accountWith("correct horse battery");
    const { repository, sessions } = createFakeRepository({
      async findAccountByEmail() {
        return account;
      },
    });
    const auth = createAuthService({ repository });

    const session = await auth.login({
      email: EMAIL,
      password: "correct horse battery",
    });

    expect(session.user.id).toBe(USER_ID);
    expect(sessions).toHaveLength(1);
  });

  it("账号不存在与口令错误返回同一个错误（不给账号枚举留信号）", async () => {
    const account = await accountWith("correct horse battery");
    const missing = createFakeRepository({
      async findAccountByEmail() {
        return null;
      },
    });
    const wrongPassword = createFakeRepository({
      async findAccountByEmail() {
        return account;
      },
    });

    const missingError = await createAuthService({
      repository: missing.repository,
    })
      .login({ email: EMAIL, password: "whatever-long" })
      .catch((error: unknown) => error);
    const wrongError = await createAuthService({
      repository: wrongPassword.repository,
    })
      .login({ email: EMAIL, password: "wrong-password" })
      .catch((error: unknown) => error);

    expect(missingError).toBeInstanceOf(AuthError);
    expect(wrongError).toBeInstanceOf(AuthError);
    expect((missingError as AuthError).code).toBe("invalid_credentials");
    expect((wrongError as AuthError).code).toBe("invalid_credentials");
    expect((missingError as AuthError).message).toBe(
      (wrongError as AuthError).message,
    );
    expect((missingError as AuthError).statusCode).toBe(401);

    // 失败登录不签发会话
    expect(missing.sessions).toHaveLength(0);
    expect(wrongPassword.sessions).toHaveLength(0);
  });
});

describe("自管认证服务：会话解析与登出", () => {
  it("按令牌哈希查会话（不查明文），命中即刷新并返回用户", async () => {
    const seen: string[] = [];
    const { repository } = createFakeRepository({
      async findSessionByTokenHash(tokenHash) {
        seen.push(tokenHash);
        return {
          email: "pro@test.loomic.com",
          expires_at: "2026-10-13T00:00:00.000Z",
          raw_user_meta_data: { display_name: "Pro Tester" },
          user_id: USER_ID,
        };
      },
    });
    const auth = createAuthService({ repository });

    const user = await auth.resolveSession("plaintext-token-value");

    expect(seen).toEqual([hashSessionToken("plaintext-token-value")]);
    expect(user).toMatchObject({
      email: "pro@test.loomic.com",
      id: USER_ID,
    });
    expect(user?.accessToken).toBe("plaintext-token-value");
  });

  it("空令牌 / 未命中 → null（不抛错，路由据此回 401）", async () => {
    const { repository } = createFakeRepository();
    const auth = createAuthService({ repository });

    await expect(auth.resolveSession("")).resolves.toBeNull();
    await expect(auth.resolveSession("unknown")).resolves.toBeNull();
  });

  it("数据访问异常折叠为 null（认证失败而非 500 泄露内部信息）", async () => {
    const { repository } = createFakeRepository({
      async findSessionByTokenHash() {
        throw new Error("db down");
      },
    });

    await expect(
      createAuthService({ repository }).resolveSession("t"),
    ).resolves.toBeNull();
  });

  it("从请求头取令牌：支持大小写与多余空格，非 Bearer 一律 null", async () => {
    expect(parseBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(parseBearerToken("bearer  abc")).toBe("abc");
    expect(parseBearerToken("Basic abc")).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();

    const account = await accountWith("correct horse battery");
    const { repository } = createFakeRepository({
      async findSessionByTokenHash(tokenHash) {
        return tokenHash === hashSessionToken("token-1")
          ? {
              email: account.email,
              expires_at: "2026-10-13T00:00:00.000Z",
              raw_user_meta_data: {},
              user_id: USER_ID,
            }
          : null;
      },
    });
    const auth = createAuthService({ repository });

    await expect(
      auth.resolveRequestUser({ headers: { authorization: "Bearer token-1" } }),
    ).resolves.toMatchObject({ id: USER_ID });
    await expect(auth.resolveRequestUser({ headers: {} })).resolves.toBeNull();
  });

  it("登出按令牌哈希删除会话（明文不落库）", async () => {
    const { deleted, repository } = createFakeRepository();
    const auth = createAuthService({ repository });

    await auth.logout("plaintext-token-value");

    expect(deleted).toEqual([hashSessionToken("plaintext-token-value")]);
  });
});
