// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSession, readStoredSession } from "../src/lib/session";

/**
 * 回归：**只在该清令牌的时候清**。
 *
 * 实测事故：dev 热重载窗口里刷新页面 = 被登出——`loadSession` 原来对任何非 2xx
 * 响应都 `persist(null)`，服务端重启/编译中的 5xx 也照清不误（用户也报过
 * 「会话失效被踢到登录页」）。只有 401（令牌确实无效/过期）才该清。
 */
const TOKEN_KEY = "kenfutwork.session.token";

describe("loadSession 的令牌保留口径", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(TOKEN_KEY, "token-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("没有本地令牌：问 /api/viewer 拿本机身份（免登录形态直接进）", async () => {
    window.localStorage.clear();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            profile: {
              id: "u1",
              email: "local@kenfutwork.local",
              displayName: "本机用户",
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const session = await loadSession();
    expect(session?.user.email).toBe("local@kenfutwork.local");
    // 免登录形态没有令牌：空串（不是 null，消费方按「无令牌」处理）
    expect(session?.access_token).toBe("");
    // 走的是 viewer（认证路由在免登录形态下没挂载）
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/viewer");
  });

  it("没有本地令牌且 viewer 也 401（口令形态）：未登录，不写任何东西", async () => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await expect(loadSession()).resolves.toBeNull();
    expect(readStoredSession()).toBeNull();
  });

  it("401（令牌无效）：清令牌", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await expect(loadSession()).resolves.toBeNull();
    expect(readStoredSession()).toBeNull();
  });

  it("5xx（服务端暂时不可用）：保留令牌，不做登录态声明", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    await expect(loadSession()).resolves.toBeNull();
    expect(readStoredSession()?.token).toBe("token-1");
  });

  it("网络不可达：保留令牌", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(loadSession()).resolves.toBeNull();
    expect(readStoredSession()?.token).toBe("token-1");
  });

  it("200：正常返回会话（令牌沿用本地那份）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              user: {
                id: "u1",
                email: "pro@test.kenfutwork.com",
                displayName: null,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const session = await loadSession();
    expect(session?.access_token).toBe("token-1");
    expect(session?.user.email).toBe("pro@test.kenfutwork.com");
  });
});
