import { describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { ToolRegistry } from "../../kernel/types.js";
import { createSearchPlugin } from "./plugin.js";
import {
  createWebSearchTool,
  parseSearchError,
  parseSearchResponse,
} from "./web-search.js";

const env = {
  agentBackendMode: "state" as const,
  agentModel: "m",
  port: 0,
  version: "t",
  webOrigin: "http://x",
};

/** 秘塔真实成功响应形状（`webpages` + `snippet`）。 */
const METASO_OK = {
  credits: 3,
  total: 21,
  webpages: [
    {
      title: "KenFutWork",
      link: "https://kenfut.example",
      snippet: "BYOK 平台",
      position: 1,
    },
  ],
};

describe("web_search 工具（§4.5 联网搜索）", () => {
  it("打到秘塔官方端点，发送 q/scope/size/page 并归一化 webpages", async () => {
    const fetchImpl = vi.fn(
      async (
        _url: string,
        _init: {
          method: "POST";
          headers: Record<string, string>;
          body: string;
        },
      ) => ({
        ok: true,
        status: 200,
        json: async () => METASO_OK,
      }),
    );
    const tool = createWebSearchTool({
      config: { provider: "metaso", apiKey: "sk-search" },
      fetchImpl,
    });
    expect(tool.name).toBe("web_search");
    expect(tool.scope).toBe("shared");

    const result = (await tool.execute(
      { query: "kenfut byok", num: 5 },
      {},
    )) as {
      query: string;
      results: Array<{ title: string; link: string; content: string }>;
    };
    expect(result.query).toBe("kenfut byok");
    expect(result.results).toEqual([
      {
        title: "KenFutWork",
        link: "https://kenfut.example",
        content: "BYOK 平台",
      },
    ]);

    // 回归：端点必须是秘塔官方主机。旧值 api.metaso.cc 是死主机（DNS 不解析），
    // 导致 web_search 无论配没配 Key 都必然失败。
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://metaso.cn/api/v1/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer sk-search",
        }),
      }),
    );

    // 回归：请求体字段名必须是上游认可的 q/scope/size/page。
    // 旧实现发 {q, num}，`num` 被上游静默忽略 → 返回条数永远不生效。
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(init?.body ?? "{}")).toEqual({
      q: "kenfut byok",
      scope: "webpage",
      size: "5",
      page: "1",
    });
  });

  it("num 缺省与越界都收敛到 1-20，并逐值转成字符串 size", async () => {
    const capture = async (args: Record<string, unknown>) => {
      const fetchImpl = vi.fn(
        async (
          _url: string,
          _init: {
            method: "POST";
            headers: Record<string, string>;
            body: string;
          },
        ) => ({
          ok: true,
          status: 200,
          json: async () => ({ webpages: [] }),
        }),
      );
      const tool = createWebSearchTool({
        config: { provider: "metaso", apiKey: "k" },
        fetchImpl,
      });
      await tool.execute(args, {});
      return JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}") as {
        size: string;
      };
    };
    expect((await capture({ query: "a" })).size).toBe("8");
    expect((await capture({ query: "a", num: 999 })).size).toBe("20");
    expect((await capture({ query: "a", num: 0 })).size).toBe("8");
    expect((await capture({ query: "a", num: -3 })).size).toBe("1");
    expect((await capture({ query: "a", num: 2.7 })).size).toBe("2");
  });

  it("端点可被显式覆盖（镜像/代理/联调）", async () => {
    const fetchImpl = vi.fn(
      async (
        _url: string,
        _init: {
          method: "POST";
          headers: Record<string, string>;
          body: string;
        },
      ) => ({
        ok: true,
        status: 200,
        json: async () => ({ webpages: [] }),
      }),
    );
    const tool = createWebSearchTool({
      config: {
        provider: "metaso",
        apiKey: "k",
        endpoint: "http://127.0.0.1:9099/search",
      },
      fetchImpl,
    });
    await tool.execute({ query: "a" }, {});
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9099/search");
  });

  it("空 query / HTTP 失败 / 无链接结果按约定处理", async () => {
    const tool = createWebSearchTool({
      config: { provider: "metaso", apiKey: "k" },
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
      })),
    });
    await expect(tool.execute({ query: " " }, {})).rejects.toThrow(
      /query 参数/,
    );
    await expect(tool.execute({ query: "x" }, {})).rejects.toThrow(
      /搜索供应商配置/,
    );
    expect(
      parseSearchResponse({ searchResultList: [{ title: "t", link: "l" }] }),
    ).toEqual([{ title: "t", link: "l", content: "" }]);
    expect(parseSearchResponse({ results: [{ title: "no-link" }] })).toEqual(
      [],
    );
  });

  it("秘塔用 HTTP 200 承载业务错误：必须抛错而不是当成 0 条结果", async () => {
    const tool = createWebSearchTool({
      config: { provider: "metaso", apiKey: "bad-key" },
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ errCode: 2005, errMsg: "API密钥无效" }),
      })),
    });
    // 回归：旧实现只看 response.ok，Key 无效会被静默吞成「搜到 0 条」。
    await expect(tool.execute({ query: "x" }, {})).rejects.toThrow(
      /API密钥无效.*搜索供应商配置/,
    );

    expect(parseSearchError({ errCode: 0 })).toBeUndefined();
    expect(parseSearchError({})).toBeUndefined();
    expect(parseSearchError({ webpages: [] })).toBeUndefined();
    expect(parseSearchError({ errCode: 9999 })).toBe("上游错误码 9999");
    expect(parseSearchError({ errCode: 2005, errMsg: "API密钥无效" })).toBe(
      "API密钥无效",
    );
  });

  it("解析兼容 webpages/snippet 与别名形状、过滤缺链接项", () => {
    expect(
      parseSearchResponse({
        webpages: [
          { title: "a", link: "https://a", snippet: "s" },
          { title: "b", url: "https://b", summary: "m" },
          { title: "no-link" },
        ],
      }),
    ).toEqual([
      { title: "a", link: "https://a", content: "s" },
      { title: "b", link: "https://b", content: "m" },
    ]);
    // 非数组 / 空负载不炸
    expect(parseSearchResponse(undefined)).toEqual([]);
    expect(parseSearchResponse({ webpages: "oops" })).toEqual([]);
    expect(parseSearchResponse({})).toEqual([]);
  });

  it("插件 enabled 判定：有 Key 才装配，工具进 ctx.tools", async () => {
    const enabled = composePlugins(
      { ...env, searchApiKey: "sk-search" } as ServerEnv,
      [createSearchPlugin()],
    );
    const tools: ToolRegistry = enabled.get("tools");
    expect(tools.get("web_search")).toBeDefined();
    enabled.dispose();

    const disabled = composePlugins({ ...env } as ServerEnv, [
      createSearchPlugin(),
    ]);
    expect(disabled.tryGet("tools")?.get("web_search")).toBeUndefined();
    disabled.dispose();
  });
});
