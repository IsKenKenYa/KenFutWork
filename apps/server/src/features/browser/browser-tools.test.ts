import { describe, expect, it, vi } from "vitest";

import type { ToolDefinition } from "../../kernel/types.js";
import { createBrowserPlugin } from "./plugin.js";

/**
 * 开发者工具数据给 agent 读的两个工具（`browser_console` / `browser_network`）。
 *
 * 这里锁三件事：① **门控**（「允许 AI 读取开发者工具数据」关掉时如实拒绝、指路，不静默给空结果）；
 * ② 过滤与条数（level / filter / limit / since）；③ 没有数据时说清楚「是这一页没输出」而不是
 * 让人以为工具坏了。
 */
function buildPluginTools(options: {
  devtoolsRead?: boolean;
  browserControl?: boolean;
  messages?: Array<{
    seq: number;
    level: "log" | "info" | "warn" | "error";
    text: string;
    at: string;
    source: "console" | "exception" | "log" | "input";
  }>;
  /** 网络请求替身（形状与 network-log 的 NetworkRequest 一致，字段可缺）。 */
  requests?: ReadonlyArray<{
    seq: number;
    method: string;
    url: string;
    type?: string;
    status?: number;
    failed?: string;
    at: string;
  }>;
}) {
  const tools = new Map<string, ToolDefinition>();
  const cdp = {
    messages: vi.fn(async () => ({
      messages: options.messages ?? [],
      nextSeq: (options.messages ?? []).at(-1)?.seq ?? 0,
    })),
    requests: vi.fn(async () => ({
      // 复制一份：只读元组不能直接当可变数组用（也不需要它可变）
      requests: [...(options.requests ?? [])],
      nextSeq: 9,
    })),
  };
  const services = new Map<string, unknown>();
  const settings = {
    browserControlEnabled: options.browserControl ?? true,
    browserDevtoolsReadEnabled: options.devtoolsRead ?? true,
    browserAutoScreenshot: false,
  };
  const ctx = {
    register(key: string, factory: () => unknown) {
      services.set(key, factory());
    },
    get(key: string) {
      if (key === "tools") {
        return {
          register(tool: ToolDefinition) {
            tools.set(tool.name, tool);
            return () => tools.delete(tool.name);
          },
        };
      }
      const value = services.get(key);
      if (value === undefined) throw new Error(`没有提供 ${key}`);
      return value;
    },
    tryGet(key: string) {
      if (key === "permissions") return { getSettings: () => settings };
      return services.get(key);
    },
    effect: () => undefined,
    on: () => () => {},
  };
  createBrowserPlugin().apply(ctx as never);
  // 插件自己会注册 browser 服务（内部建的是真会话）：这里按 kernel 的「overrides 优先」口径
  // 换成替身，工具从 ctx.get("browser") 取的就是它
  services.set("browser", { cdp });
  return { tools, cdp, settings };
}

const call = (tools: Map<string, ToolDefinition>, name: string, args = {}) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`没有注册 ${name}`);
  return tool.execute(args, {} as never);
};

const SAMPLE = [
  {
    seq: 1,
    level: "log" as const,
    text: "你好",
    at: "2026-09-18T00:00:01.000Z",
    source: "console" as const,
  },
  {
    seq: 2,
    level: "warn" as const,
    text: "注意",
    at: "2026-09-18T00:00:02.000Z",
    source: "console" as const,
  },
  {
    seq: 3,
    level: "error" as const,
    text: "ReferenceError: nope",
    at: "2026-09-18T00:00:03.000Z",
    source: "exception" as const,
  },
];

describe("browser_console", () => {
  it("默认给全部；带 level=error 只给错误；带 level=warn 给 warn + error（含更严重的）", async () => {
    const { tools } = buildPluginTools({ messages: SAMPLE });
    const all = (await call(tools, "browser_console")) as {
      messages: Array<{ level: string }>;
      nextSeq: number;
    };
    expect(all.messages.map((m) => m.level)).toEqual(["log", "warn", "error"]);
    expect(all.nextSeq).toBe(3);

    const errors = (await call(tools, "browser_console", {
      level: "error",
    })) as {
      messages: Array<{ text: string }>;
    };
    expect(errors.messages.map((m) => m.text)).toEqual([
      "ReferenceError: nope",
    ]);

    const warns = (await call(tools, "browser_console", { level: "warn" })) as {
      messages: Array<{ level: string }>;
    };
    expect(warns.messages.map((m) => m.level)).toEqual(["warn", "error"]);
  });

  it("limit 取**最后** N 条（最近的更重要）", async () => {
    const { tools } = buildPluginTools({ messages: SAMPLE });
    const limited = (await call(tools, "browser_console", { limit: 2 })) as {
      messages: Array<{ text: string }>;
    };
    expect(limited.messages.map((m) => m.text)).toEqual([
      "注意",
      "ReferenceError: nope",
    ]);
  });

  it("since 透给会话（只看新增）；没有新消息时说清楚", async () => {
    const { tools, cdp } = buildPluginTools({ messages: [] });
    const result = (await call(tools, "browser_console", { since: 12 })) as {
      messages: unknown[];
      note?: string;
    };
    expect(cdp.messages).toHaveBeenCalledWith(12);
    expect(result.messages).toEqual([]);
    expect(result.note).toContain("没有新的控制台输出");
  });

  it("开关关掉：**如实拒绝**并指路（不返回空结果冒充「页面没问题」）", async () => {
    const { tools, cdp } = buildPluginTools({ devtoolsRead: false });
    await expect(call(tools, "browser_console")).rejects.toThrow(
      /允许 AI 读取开发者工具数据/,
    );
    expect(cdp.messages).not.toHaveBeenCalled();
  });

  it("浏览器控制关掉：先被控制门拦下（两条门各说各的原因）", async () => {
    const { tools } = buildPluginTools({ browserControl: false });
    await expect(call(tools, "browser_console")).rejects.toThrow(
      /浏览器控制未开启/,
    );
  });
});

describe("browser_network", () => {
  // as const：下标取到的就是这一条（不开 noUncheckedIndexedAccess 的 undefined 分支）
  const REQUESTS = [
    { seq: 1, method: "GET", url: "https://a.com/ok", status: 200, at: "t" },
    {
      seq: 2,
      method: "POST",
      url: "https://a.com/boom",
      status: 500,
      at: "t",
    },
    {
      seq: 3,
      method: "GET",
      url: "https://a.com/dead",
      failed: "ERR_CONNECTION_REFUSED",
      at: "t",
    },
    { seq: 4, method: "GET", url: "https://a.com/pending", at: "t" },
  ] as const;

  it("默认给全部（含进行中的）；filter=failed 只给失败与 4xx/5xx", async () => {
    const { tools } = buildPluginTools({ requests: REQUESTS });
    const all = (await call(tools, "browser_network")) as {
      requests: Array<{ url: string }>;
      nextSeq: number;
    };
    expect(all.requests).toHaveLength(4);
    expect(all.nextSeq).toBe(9);

    const failed = (await call(tools, "browser_network", {
      filter: "failed",
    })) as { requests: Array<{ url: string }> };
    expect(failed.requests.map((entry) => entry.url)).toEqual([
      "https://a.com/boom",
      "https://a.com/dead",
    ]);
  });

  it("没有失败请求时说清楚（而不是让人以为工具坏了）", async () => {
    const { tools } = buildPluginTools({ requests: [REQUESTS[0]] });
    const result = (await call(tools, "browser_network", {
      filter: "failed",
    })) as { requests: unknown[]; note?: string };
    expect(result.requests).toEqual([]);
    expect(result.note).toContain("没有失败");
  });

  it("开关关掉：同样如实拒绝", async () => {
    const { tools, cdp } = buildPluginTools({
      devtoolsRead: false,
      requests: REQUESTS,
    });
    await expect(call(tools, "browser_network")).rejects.toThrow(
      /允许 AI 读取开发者工具数据/,
    );
    expect(cdp.requests).not.toHaveBeenCalled();
  });
});
