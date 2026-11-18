import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTerminalShells } from "../src/lib/terminal-api";

/**
 * 终端的 shell 列表读取：本机实例没有 JS 令牌（凭据在 HttpOnly cookie 里），
 * 没令牌时**不能**带 `Authorization: Bearer null` —— 服务端本机接入门把
 * 「cookie + 冲突 Authorization」判为无效凭据 401，前端会整树切到「本机连接已失效」
 * （真机模拟点击踩到：打开设置 → /api/code/shells 401 → 整页失效）。
 */

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status = 200) {
  const payload =
    status === 200
      ? {
          shells: [{ id: "cmd", label: "cmd", executable: "cmd.exe" }],
          defaultShell: "auto",
          resolvedShell: "cmd",
        }
      : { error: { code: "unauthorized", message: "未授权" } };
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(payload, { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchTerminalShells 的鉴权头口径", () => {
  it("无令牌（本机 cookie 接入）→ 不带 Authorization，且带 cookie（credentials: include）", async () => {
    const fetchMock = stubFetch();
    const result = await fetchTerminalShells(null);
    expect(result.shells).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls.at(0) ?? [];
    expect(String(url)).toContain("/api/code/shells");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(init?.credentials).toBe("include");
  });

  it("有令牌（脚本/远端形态）→ 原样透传 Bearer", async () => {
    const fetchMock = stubFetch();
    await fetchTerminalShells("tok-123");
    const [, init] = fetchMock.mock.calls.at(0) ?? [];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
  });

  it("401 仍然按接入失效抛出（不吞错）", async () => {
    stubFetch(401);
    await expect(fetchTerminalShells(null)).rejects.toThrow();
  });
});
