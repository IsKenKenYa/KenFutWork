// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { pickDirectory } from "../src/lib/server-api";

/**
 * 「打开文件夹」的请求形状回归。
 *
 * 历史 bug：POST /api/system/pick-directory 带 `content-type: application/json`
 * 却不带 body——Fastify 直接 400（FST_ERR_CTP_EMPTY_JSON_BODY），错误体里
 * `error` 是字符串 "Bad Request"、取不到 `error.message`，用户只看到一句
 * 没头没尾的 "系统文件夹对话框不可用：Request failed"（真机 2026-09-20 截图）。
 * 这里锁死：这个请求**必须**带 JSON 体（服务端不读 body，`{}` 即可）。
 */
describe("pickDirectory 请求形状", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POST 带 JSON 头时必须带 body（{}），并附 Bearer token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "cancelled" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await pickDirectory("token-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toContain("/api/system/pick-directory");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers.Authorization).toBe("Bearer token-1");
    expect(init.body).toBe("{}");
  });

  it("响应照常透传给调用方（cancelled 静默路径依赖它）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "picked", path: "/tmp/demo" }),
      })),
    );

    await expect(pickDirectory("token-2")).resolves.toEqual({
      status: "picked",
      path: "/tmp/demo",
    });
  });
});
