import { describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { ToolRegistry } from "../../kernel/types.js";
import { createSearchPlugin } from "./plugin.js";
import {
  createWebChannelSearchTool,
  createWebSearchTool,
  hrefFromHint,
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

  /**
   * 回归背景（2026-09-20 真机走查）：文档口径是「不配 Key 也能搜（走网页通道）」，但此前
   * 唯一的执行面 `browser_open` 受「允许 AI 控制浏览器」开关门控、该开关默认关——于是
   * 开箱状态下 `web_search` 不装配 + `browser_open` 被拒 = **实际搜不了**。
   * 现在两条实现都贡献同名 `web_search`：配了 Key 走结构化 API，没配走网页通道。
   *
   * 浏览器缝用 override 顶掉（起真 plugin 要 Fastify 实例，这里只关心装的哪个工具）。
   */
  const fakeBrowser = {
    snapshot: async () => ({ title: "t", text: "", elements: [] }),
    cdp: {},
  } as never;

  it("插件装配：有 Key 走结构化 API，没 Key 走网页通道，两边都注册 web_search", () => {
    for (const withKey of [true, false]) {
      const composed = composePlugins(
        {
          ...env,
          ...(withKey ? { searchApiKey: "sk-search" } : {}),
        } as ServerEnv,
        [createSearchPlugin()],
        { overrides: { browser: fakeBrowser } },
      );
      const tools: ToolRegistry = composed.get("tools");
      const tool = tools.get("web_search");
      expect(tool).toBeDefined();
      // 文案点出这条工具当前走的是哪条路（模型据此判断结果性质）
      expect(tool?.description ?? "").toContain(
        withKey ? "公开网页" : "结果页",
      );
      composed.dispose();
    }
  });

  it("没配 Key 时不再整块关掉插件（那是「不配就不能搜」的老行为）", () => {
    const composed = composePlugins(
      { ...env } as ServerEnv,
      [createSearchPlugin()],
      { overrides: { browser: fakeBrowser } },
    );
    const tools: ToolRegistry = composed.get("tools");
    expect(tools.get("web_search")).toBeDefined();
    composed.dispose();
  });
});

describe("网页通道搜索（没配 Key 时的执行面）", () => {
  /**
   * 真实的 hint 形态是 `a[href="…"]`——**带引号**。这里按真机形状造数据：
   * 早期用不带引号的形状写测试，结果线上「结果集恒为空」没被测出来（2026-09-20 实测）。
   */
  const anchor = (text: string, href: string) => ({
    tag: "a",
    text,
    hint: `a[href="${href}"]`,
  });

  const snapshotOf = (
    elements: { tag: string; text: string; hint: string }[],
  ) => ({
    title: "Bing",
    text: "",
    elements,
  });

  it("抓结果页 → 只留外部链接（引擎自己的导航链接剔掉）", async () => {
    const tool = createWebChannelSearchTool({
      snapshot: async () =>
        snapshotOf([
          anchor("登录", "https://www.bing.com/login"),
          anchor("下一个", "https://cn.bing.com/search?q=x&first=10"),
          anchor("KenFutWork 官网", "https://kenfut.example/"),
          anchor("文档", "https://docs.kenfut.example/start"),
        ]),
    });
    const result = (await tool.execute({ query: "KenFutWork" }, {})) as {
      results: { title: string; link: string }[];
      channel: string;
      engine: string;
    };
    expect(result.channel).toBe("web");
    expect(result.engine).toBe("Bing");
    expect(result.results.map((r) => r.link)).toEqual([
      "https://kenfut.example/",
      "https://docs.kenfut.example/start",
    ]);
  });

  it("带引号的 hint 能取到 href（回归：不带引号的正则让结果集恒为空）", () => {
    expect(hrefFromHint('a[href="https://x.example/a"]')).toBe(
      "https://x.example/a",
    );
    expect(hrefFromHint("a[href='https://x.example/b']")).toBe(
      "https://x.example/b",
    );
    expect(hrefFromHint("a[href=https://x.example/c]")).toBe(
      "https://x.example/c",
    );
    expect(hrefFromHint('a[href="#"]')).toBe("#");
    expect(hrefFromHint("a.title")).toBe("");
  });

  it("相对链接 / javascript: / 无文字链接都不当成结果（拿不到绝对地址就不编）", async () => {
    const tool = createWebChannelSearchTool({
      snapshot: async () =>
        snapshotOf([
          anchor("相对链接", "/search?q=x"),
          anchor("脚本", "javascript:void(0)"),
          anchor("", "https://kenfut.example/empty"),
          anchor("真结果", "https://kenfut.example/real"),
        ]),
    });
    const result = (await tool.execute({ query: "x" }, {})) as {
      results: { link: string }[];
    };
    expect(result.results.map((r) => r.link)).toEqual([
      "https://kenfut.example/real",
    ]);
  });

  it("重复链接只留第一条；num 上限 20、下限 1", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      anchor(`结果${i}`, `https://site${i}.example/`),
    );
    const tool = createWebChannelSearchTool({
      snapshot: async () =>
        snapshotOf([
          anchor("重复", "https://kenfut.example/"),
          anchor("重复再来", "https://kenfut.example/"),
          ...many,
        ]),
    });
    const capped = (await tool.execute({ query: "x", num: 99 }, {})) as {
      results: { link: string }[];
    };
    expect(capped.results).toHaveLength(20);
    expect(capped.results[0]?.link).toBe("https://kenfut.example/");
    const floored = (await tool.execute({ query: "x", num: 0 }, {})) as {
      results: unknown[];
    };
    expect(floored.results).toHaveLength(8); // 0 不是合法条数 → 回落默认 8
  });

  it("一条都没解析出来时如实说明（不假装搜到了，且给出可行的替代）", async () => {
    const tool = createWebChannelSearchTool({
      snapshot: async () =>
        snapshotOf([anchor("登录", "https://www.bing.com/login")]),
    });
    const result = (await tool.execute({ query: "x" }, {})) as {
      results: unknown[];
      note: string;
    };
    expect(result.results).toEqual([]);
    expect(result.note).toContain("没解析出可用的结果链接");
    // 要点出「不是搜不到」以及三条替代路
    expect(result.note).toContain("不是「搜不到」");
    expect(result.note).toContain("browser_navigate");
    expect(result.note).toContain("搜索供应商 Key");
  });

  it("换引擎（baidu）时按引擎口径剔自己的域名", async () => {
    const tool = createWebChannelSearchTool({
      engine: "baidu",
      snapshot: async () =>
        snapshotOf([
          anchor("百度一下", "https://www.baidu.com/"),
          anchor("结果", "https://kenfut.example/"),
        ]),
    });
    const result = (await tool.execute({ query: "x" }, {})) as {
      engine: string;
      results: { link: string }[];
    };
    expect(result.engine).toBe("百度");
    expect(result.results.map((r) => r.link)).toEqual([
      "https://kenfut.example/",
    ]);
  });

  it("空 query 抛可读错误（与结构化那条同一口径）", async () => {
    const tool = createWebChannelSearchTool({
      snapshot: async () => snapshotOf([]),
    });
    await expect(tool.execute({ query: "  " }, {})).rejects.toThrow(
      "web_search 需要 query 参数",
    );
  });
});

/**
 * 回归（GUI 全流程实测）：工具错误若不是「面向用户」的，会被通用 sanitizer 压成
 * 「请求处理失败，请重试。」——用户看不出是 Key 的问题。这里把「可读文案必须带
 * exposeToClient 标记」锁死，防止以后新增抛错点时漏标记。
 */
describe("web_search 的错误是面向用户的（可透传到客户端）", () => {
  it("Key 无效 / 缺 Key / 缺参数：抛出的错误都带 exposeToClient", async () => {
    const noKey = createWebSearchTool({
      config: { provider: "metaso", apiKey: "" },
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ errCode: 2005, errMsg: "API密钥无效" }),
      })),
    });
    await expect(noKey.execute({ query: "x" }, {})).rejects.toMatchObject({
      exposeToClient: true,
    });

    const missingQuery = createWebSearchTool({
      config: { provider: "metaso", apiKey: "k" },
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ webpages: [] }),
      })),
    });
    await expect(
      missingQuery.execute({ query: " " }, {}),
    ).rejects.toMatchObject({ exposeToClient: true });
  });
});
