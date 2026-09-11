import { describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { ToolRegistry } from "../../kernel/types.js";
import { createSearchPlugin } from "./plugin.js";
import { createWebSearchTool, parseSearchResponse } from "./web-search.js";

const env = {
  agentBackendMode: "state" as const,
  agentModel: "m",
  port: 0,
  version: "t",
  webOrigin: "http://x",
};

describe("web_search 工具（§4.5 联网搜索）", () => {
  it("发起带鉴权的搜索请求并归一化结果", async () => {
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
        json: async () => ({
          results: [
            {
              title: "Loomic",
              link: "https://loomic.example",
              content: "BYOK 平台",
            },
          ],
        }),
      }),
    );
    const tool = createWebSearchTool({
      config: { provider: "metaso", apiKey: "sk-search" },
      fetchImpl,
    });
    expect(tool.name).toBe("web_search");
    expect(tool.scope).toBe("shared");

    const result = (await tool.execute(
      { query: "loomic byok", num: 5 },
      {},
    )) as { query: string; results: Array<{ title: string }> };
    expect(result.query).toBe("loomic byok");
    expect(result.results[0]?.title).toBe("Loomic");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.metaso.cc/v1/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer sk-search",
        }),
      }),
    );
    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body ?? "{}") as { q: string; num: number };
    expect(body).toEqual({ q: "loomic byok", num: 5 });
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
