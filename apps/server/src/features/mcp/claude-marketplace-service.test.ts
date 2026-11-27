import { describe, expect, it } from "vitest";
import { createClaudeMarketplaceService } from "./claude-marketplace-service.js";

/**
 * 文件来源替身：按 URL 里的「仓库/版本/路径」只取路径部分查表，记录读取次数。
 * 只替身「网络读取」这一层，解析、换算、缓存、进度都是真实实现。
 */
function fileSource(files: Record<string, string | "404" | "error">) {
  const reads: string[] = [];
  return {
    reads,
    async fetchFile(url: string) {
      reads.push(url);
      // https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path...>
      const rest = url.replace(/^https:\/\/raw\.githubusercontent\.com\//u, "");
      const parts = rest.split("/");
      const relative = parts.slice(3).join("/");
      const found = files[relative] ?? "404";
      if (found === "error") throw new Error("网络中断");
      return found === "404" ? null : found;
    },
  };
}

const MARKETPLACE = JSON.stringify({
  name: "claude-plugins-official",
  owner: { name: "Anthropic" },
  plugins: [
    {
      name: "neon",
      description: "Neon 数据库",
      category: "database",
      source: "./plugins/neon",
    },
    {
      name: "convex",
      description: "Convex 后端",
      author: { name: "Convex" },
      source: {
        source: "git-subdir",
        url: "https://github.com/get-convex/convex-backend-skill.git",
        path: "plugins/convex",
        sha: "6ca54f6e2e7582812187b8a5a4783fb4dff52692",
      },
    },
    {
      name: "broken",
      description: "读不到",
      source: {
        source: "url",
        url: "https://github.com/broken/repo.git",
        sha: "ffffffffffffffffffffffffffffffffffffffff",
      },
    },
  ],
});

const NEON_MCP = JSON.stringify({
  mcpServers: {
    neon: { type: "http", url: "https://mcp.neon.tech/mcp" },
  },
});

const CONVEX_PLUGIN = JSON.stringify({
  name: "convex",
  mcpServers: {
    convex: { command: "npx", args: ["-y", "convex-mcp"] },
  },
});

function serviceWith(
  options: {
    files?: Record<string, string | "404" | "error">;
    limits?: { timeoutMs: number; maxBytes: number; concurrency: number };
    ttlMs?: number;
    now?: () => number;
  } = {},
) {
  const source = fileSource(
    options.files ?? {
      ".claude-plugin/marketplace.json": MARKETPLACE,
      "plugins/neon/.mcp.json": NEON_MCP,
      "plugins/convex/.claude-plugin/plugin.json": CONVEX_PLUGIN,
    },
  );
  const now = options.now ?? (() => Date.now());
  const service = createClaudeMarketplaceService({
    fetchFile: source.fetchFile,
    readLimits: async () =>
      options.limits ?? {
        timeoutMs: 15_000,
        maxBytes: 2_097_152,
        concurrency: 4,
      },
    readCacheTtlMs: async () => options.ttlMs ?? 60_000,
    now,
  });
  return { service, source };
}

/**
 * 等后台读取跑完（真实 promise 链，不用假计时器）。
 * 首次读取看 state 离开 loading；刷新时 state 一直是 ready，看 refreshing 落下。
 */
async function settle(service: ReturnType<typeof serviceWith>["service"]) {
  for (let index = 0; index < 400; index += 1) {
    const snapshot = service.read();
    if (snapshot.state !== "loading" && !snapshot.refreshing) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return service.read();
}

describe("Claude 市场读取服务", () => {
  it("首次读取立即返回 loading，读完是完整结果", async () => {
    const { service, source } = serviceWith();
    const first = service.read();
    expect(first.state).toBe("loading");
    expect(first.servers).toEqual([]);
    const done = await settle(service);
    expect(done.state).toBe("ready");
    expect(done.total).toBe(3);
    expect(done.checked).toBe(3);
    expect(done.marketplace).toEqual({
      name: "claude-plugins-official",
      owner: "Anthropic",
    });
    expect(done.servers.map((server) => server.id)).toEqual([
      "convex:convex",
      "neon:neon",
    ]);
    // broken 只是没有 MCP 声明（两个文件都 404），不算读取失败
    expect(done.unreadable).toBe(0);
    expect(done.completedAt).not.toBeNull();
    // 三个插件 + 市场清单：neon 读 .mcp.json（plugin.json 404），convex 读 .mcp.json(404)+plugin.json
    expect(source.reads.length).toBeGreaterThanOrEqual(6);
    service.shutdown();
  });

  it("缓存期内不重读，过期后重读；读完才替换（刷新期间给旧结果）", async () => {
    let clock = 1_000_000;
    const { service, source } = serviceWith({ now: () => clock, ttlMs: 1_000 });
    await settle(service);
    const readsAfterFirst = source.reads.length;

    clock += 500;
    service.read();
    expect(source.reads.length).toBe(readsAfterFirst);

    clock += 1_000; // 超过 1 秒
    const stale = service.read();
    expect(stale.state).toBe("ready");
    expect(stale.servers).toHaveLength(2);
    expect(stale.refreshing).toBe(true);
    await settle(service);
    expect(source.reads.length).toBeGreaterThan(readsAfterFirst);
    service.shutdown();
  });

  it("refresh 强制重读，不依赖缓存时间", async () => {
    const { service, source } = serviceWith({ ttlMs: 86_400_000 });
    await settle(service);
    const before = source.reads.length;
    service.refresh();
    await settle(service);
    expect(source.reads.length).toBeGreaterThan(before);
    service.shutdown();
  });

  it("市场清单读不到：state=failed 并给原因；短时间轮询不重复打上游", async () => {
    let clock = 1_000_000;
    const { service, source } = serviceWith({
      files: { ".claude-plugin/marketplace.json": "error" },
      now: () => clock,
    });
    const failed = await settle(service);
    expect(failed.state).toBe("failed");
    expect(failed.message).toContain("网络中断");
    const attempts = source.reads.length;
    clock += 1_000;
    service.read();
    expect(source.reads.length).toBe(attempts);
    service.shutdown();
  });

  it("单个插件读取失败不影响其余结果，只计入 unreadable", async () => {
    const { service } = serviceWith({
      files: {
        ".claude-plugin/marketplace.json": MARKETPLACE,
        "plugins/neon/.mcp.json": NEON_MCP,
        "plugins/convex/.claude-plugin/plugin.json": "error",
      },
    });
    const done = await settle(service);
    expect(done.state).toBe("ready");
    expect(done.servers.map((server) => server.id)).toEqual(["neon:neon"]);
    expect(done.unreadable).toBe(1);
    expect(done.unreadablePlugins.map((entry) => entry.plugin)).toEqual([
      "convex",
    ]);
    service.shutdown();
  });

  it("find 能取回模板，不在结果里时给可读原因", async () => {
    const { service } = serviceWith();
    await settle(service);
    const found = service.find("neon:neon");
    expect(found.view).toMatchObject({
      id: "neon:neon",
      kind: "http",
      addable: true,
      plugin: "neon",
    });
    expect(found.template?.url).toBe("https://mcp.neon.tech/mcp");
    expect(() => service.find("缺:缺")).toThrow(/不在当前市场结果里/);
    service.shutdown();
  });

  it("读到的服务里，不可添加的也保留在快照里（带原因）", async () => {
    const { service } = serviceWith({
      files: {
        ".claude-plugin/marketplace.json": JSON.stringify({
          name: "m",
          owner: { name: "o" },
          plugins: [{ name: "p", source: "./plugins/p" }],
        }),
        "plugins/p/.mcp.json": JSON.stringify({
          mcpServers: {
            remote: {
              type: "http",
              url: "https://a/mcp",
              oauth: { clientId: "x" },
            },
            local: { command: "npx", args: ["-y", "x"] },
          },
        }),
      },
    });
    const done = await settle(service);
    expect(done.servers.map((server) => server.serverName).sort()).toEqual([
      "local",
      "remote",
    ]);
    expect(
      done.servers.find((server) => server.serverName === "remote"),
    ).toMatchObject({
      addable: false,
      unsupportedReason: "要登录授权才能连接",
    });
    service.shutdown();
  });

  it("shutdown 后不再发起读取", async () => {
    const { service, source } = serviceWith();
    service.shutdown();
    service.read();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(source.reads).toEqual([]);
  });
});
