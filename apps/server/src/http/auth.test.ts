import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { AuthError, type AuthService } from "../features/auth/service.js";
import type { AuthenticatedUser } from "../supabase/user.js";
import { registerAuthRoutes } from "./auth.js";

const USER: AuthenticatedUser = {
  accessToken: "token-1",
  email: "pro@test.loomic.com",
  id: "user-1",
  userMetadata: { display_name: "Pro Tester" },
};

function fakeService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    async login() {
      return {
        expiresAt: "2026-10-13T00:00:00.000Z",
        token: "session-token",
        user: USER,
      };
    },
    async logout() {},
    async register() {
      return {
        expiresAt: "2026-10-13T00:00:00.000Z",
        token: "session-token",
        user: USER,
      };
    },
    async resolveRequestUser() {
      return null;
    },
    async resolveSession() {
      return null;
    },
    ...overrides,
  };
}

async function buildApp(service: AuthService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerAuthRoutes(app, { authService: service });
  return app;
}

describe("POST /api/auth/register", () => {
  it("合法请求 → 201，响应含明文令牌与用户（并带 displayName）", async () => {
    const seen: unknown[] = [];
    const app = await buildApp(
      fakeService({
        async register(input) {
          seen.push(input);
          return {
            expiresAt: "2026-10-13T00:00:00.000Z",
            token: "session-token",
            user: USER,
          };
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        displayName: "Pro Tester",
        email: "pro@test.loomic.com",
        password: "long-enough-1",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      session: {
        expiresAt: "2026-10-13T00:00:00.000Z",
        token: "session-token",
      },
      user: {
        displayName: "Pro Tester",
        email: "pro@test.loomic.com",
        id: "user-1",
      },
    });
    expect(seen).toEqual([
      {
        displayName: "Pro Tester",
        email: "pro@test.loomic.com",
        password: "long-enough-1",
      },
    ]);
  });

  it("口令过短 / 邮箱非法 → 400，且不触达服务", async () => {
    let called = 0;
    const app = await buildApp(
      fakeService({
        async register() {
          called += 1;
          throw new Error("不应被调用");
        },
      }),
    );

    const short = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "a@b.com", password: "short" },
    });
    const badEmail = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "not-an-email", password: "long-enough-1" },
    });

    expect(short.statusCode).toBe(400);
    expect(badEmail.statusCode).toBe(400);
    expect(called).toBe(0);
  });

  it("邮箱已存在 → 409 且返回共享契约的错误形状", async () => {
    const app = await buildApp(
      fakeService({
        async register() {
          throw new AuthError("email_taken", "该邮箱已被注册。", 409);
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "a@b.com", password: "long-enough-1" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: "email_taken", message: "该邮箱已被注册。" },
    });
  });

  it("未知异常 → 500 且不回显内部错误文本", async () => {
    const app = await buildApp(
      fakeService({
        async register() {
          throw new Error("connection refused to 10.0.0.5");
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "a@b.com", password: "long-enough-1" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("auth_unavailable");
    expect(JSON.stringify(response.json())).not.toContain("10.0.0.5");
  });
});

describe("POST /api/auth/login", () => {
  it("成功 → 200 + 会话", async () => {
    const app = await buildApp(fakeService());

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "pro@test.loomic.com", password: "whatever" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().session.token).toBe("session-token");
  });

  it("口令错误 → 401 invalid_credentials", async () => {
    const app = await buildApp(
      fakeService({
        async login() {
          throw new AuthError("invalid_credentials", "邮箱或口令不正确。", 401);
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "pro@test.loomic.com", password: "wrong" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_credentials");
  });
});

describe("POST /api/auth/logout", () => {
  it("带令牌 → 204 且按明文令牌调用登出", async () => {
    const tokens: string[] = [];
    const app = await buildApp(
      fakeService({
        async logout(token) {
          tokens.push(token);
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { authorization: "Bearer session-token" },
    });

    expect(response.statusCode).toBe(204);
    expect(tokens).toEqual(["session-token"]);
  });

  it("无令牌 → 204（幂等：前端清本地状态即可，不该报错）", async () => {
    const app = await buildApp(fakeService());
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
    });

    expect(response.statusCode).toBe(204);
  });
});

describe("GET /api/auth/session", () => {
  it("令牌有效 → 200 + 用户", async () => {
    const app = await buildApp(
      fakeService({
        async resolveRequestUser() {
          return USER;
        },
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { authorization: "Bearer session-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        displayName: "Pro Tester",
        email: "pro@test.loomic.com",
        id: "user-1",
      },
    });
  });

  it("令牌无效/缺失 → 401（前端据此跳登录）", async () => {
    const app = await buildApp(fakeService());

    const noHeader = await app.inject({
      method: "GET",
      url: "/api/auth/session",
    });
    expect(noHeader.statusCode).toBe(401);
    expect(noHeader.json().error.code).toBe("unauthorized");
  });
});
