// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_TRUST_SESSION_TOKEN,
  loadSession,
  readStoredSession,
} from "../src/lib/session";

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
    /**
     * 免登录形态不发令牌，但**必须给非空标记**：客户端几十处「无令牌即未登录」的门
     * （`if (!session?.access_token) return`）否则全部静默不放行——真机上表现为工作台
     * 拉不到项目、Design 模式永远停在「暂无项目」、画布起不来（2026-09-19 安装包实测）。
     */
    expect(session?.access_token).toBe(LOCAL_TRUST_SESSION_TOKEN);
    // 走的是 viewer（认证路由在免登录形态下没挂载）
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/viewer");
    // 标记不落盘：刷新页面重新问 viewer，不把「标记」当令牌存起来
    expect(readStoredSession()).toBeNull();
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

  it("404（该服务端不是口令形态，认证路由未挂载）：清旧令牌并回落问 viewer，拿到本机身份", async () => {
    /**
     * 真机事故（2026-09-28）：Tauri WebView 残留口令形态登录的旧令牌，dev.sh 把
     * 服务端拉在 local-trust（认证路由不挂载，`/api/auth/session` 永远 404）。
     * 旧代码把 404 归入「服务端暂时不可用、不动令牌」——令牌永远清不掉，永远
     * 停在登录页。404 在这里是**明确的形态判定信号**：这台服务端没有口令认证面，
     * 任何本地令牌都永久无效，必须清掉并走 `/api/viewer` 免登录探活。
     */
    window.localStorage.setItem(TOKEN_KEY, "stale-managed-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/session")) {
        return new Response("{}", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          profile: {
            id: "u1",
            email: "local@kenfutwork.local",
            displayName: "本机用户",
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const session = await loadSession();
    expect(session?.user.email).toBe("local@kenfutwork.local");
    expect(session?.access_token).toBe(LOCAL_TRUST_SESSION_TOKEN);
    // 旧令牌确实被清了，后续刷新不再空跑一趟 404
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
