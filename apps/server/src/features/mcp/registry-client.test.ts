import { describe, expect, it, vi } from "vitest";

import { buildCuratedArgs, CURATED_MCP_SERVERS } from "./curated-catalog.js";
import {
  clearRegistryCache,
  dedupeRegistryServers,
  packageToCommand,
  registryNameToServerName,
  searchOfficialRegistry,
  toRegistryServerView,
} from "./registry-client.js";

/**
 * MCP 目录与官方注册表（用户要求「两条都要做」）。
 * 这里锁：内置目录的参数渲染、注册表条目的可安装判定（stdio + npm/pypi）、
 * 名称合法化、以及网络失败必须抛错（不假装"没有结果"）。
 */
describe("内置精选目录", () => {
  it("每条都有命令与必填参数声明，且模板里的占位符都有对应参数", () => {
    expect(CURATED_MCP_SERVERS.length).toBeGreaterThanOrEqual(6);
    for (const entry of CURATED_MCP_SERVERS) {
      expect(entry.command, entry.id).toBeTruthy();
      const placeholders = entry.argsTemplate
        .filter((arg) => /^\{\{\w+\}\}$/.test(arg))
        .map((arg) => arg.slice(2, -2));
      for (const key of placeholders) {
        expect(
          entry.params.some((param) => param.key === key),
          `${entry.id} 缺少参数声明 ${key}`,
        ).toBe(true);
      }
    }
  });

  it("参数渲染：必填缺失会被报出来且不产出空参数", () => {
    const filesystem = CURATED_MCP_SERVERS.find((e) => e.id === "filesystem");
    if (!filesystem) throw new Error("filesystem 条目缺失");

    const missing = buildCuratedArgs(filesystem, {});
    expect(missing.missing).toEqual(["允许访问的目录"]);
    expect(missing.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
    ]);

    const ok = buildCuratedArgs(filesystem, { dir: "D:/proj" });
    expect(ok.missing).toEqual([]);
    expect(ok.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "D:/proj",
    ]);
  });

  it("无参数条目直接产出固定参数", () => {
    const fetchEntry = CURATED_MCP_SERVERS.find((e) => e.id === "fetch");
    if (!fetchEntry) throw new Error("fetch 条目缺失");
    expect(buildCuratedArgs(fetchEntry, {}).args).toEqual(["mcp-server-fetch"]);
  });
});

describe("官方注册表条目映射", () => {
  it("npm + stdio：可安装，建议命令为 npx -y <pkg>@<version>", () => {
    const view = toRegistryServerView({
      server: {
        name: "io.github.user/filesystem",
        description: "文件系统",
        version: "1.0.2",
        repository: { url: "https://github.com/user/repo" },
        packages: [
          {
            registryType: "npm",
            identifier: "@modelcontextprotocol/server-filesystem",
            version: "1.0.2",
            transportType: "stdio",
          },
        ],
      },
    });
    expect(view.installable).toBe(true);
    expect(view.suggestedCommand).toBe("npx");
    expect(view.suggestedArgs).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem@1.0.2",
    ]);
    expect(view.suggestedName).toBe("filesystem");
    expect(view.unsupportedReason).toBeNull();
  });

  it("pypi + stdio：建议命令为 uvx <pkg>==<version>", () => {
    const view = toRegistryServerView({
      server: {
        name: "io.modelcontextprotocol/fetch",
        packages: [
          {
            registryType: "pypi",
            identifier: "mcp-server-fetch",
            version: "0.6.0",
            transportType: "stdio",
          },
        ],
      },
    });
    expect(view.installable).toBe(true);
    expect(view.suggestedCommand).toBe("uvx");
    expect(view.suggestedArgs).toEqual(["mcp-server-fetch==0.6.0"]);
  });

  it("只有远程（HTTP/SSE）：不可安装且给出原因（不静默）", () => {
    const view = toRegistryServerView({
      server: {
        name: "com.example/remote",
        remotes: [{ type: "sse", url: "https://example.com/sse" }],
      },
    });
    expect(view.installable).toBe(false);
    expect(view.unsupportedReason).toContain("远程");
  });

  it("不支持包生态（oci）与缺包：不可安装且原因可读", () => {
    const oci = toRegistryServerView({
      server: {
        name: "com.example/oci",
        packages: [
          {
            registryType: "oci",
            identifier: "ghcr.io/x/y",
            transportType: "stdio",
          },
        ],
      },
    });
    expect(oci.installable).toBe(false);
    expect(oci.unsupportedReason).toContain("oci");

    const empty = toRegistryServerView({
      server: { name: "com.example/none" },
    });
    expect(empty.installable).toBe(false);
    expect(empty.unsupportedReason).toContain("未声明");
  });

  it("名称合法化：取尾段并清洗非法字符，空则回落默认名", () => {
    expect(registryNameToServerName("io.github.user/filesystem")).toBe(
      "filesystem",
    );
    expect(registryNameToServerName("a/b/weird name!")).toBe("weird-name");
    expect(registryNameToServerName("///")).toBe("mcp-server");
  });

  it("packageToCommand：无 identifier 返回 null", () => {
    expect(
      packageToCommand({ registryType: "npm", identifier: "  " }),
    ).toBeNull();
  });
});

describe("官方注册表检索", () => {
  it("成功：映射条目并缓存（同 key 第二次不再打网络）", async () => {
    clearRegistryCache();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        servers: [
          {
            server: {
              name: "io.github.user/fs",
              packages: [
                {
                  registryType: "npm",
                  identifier: "pkg",
                  transportType: "stdio",
                },
              ],
            },
          },
        ],
        metadata: { count: 1, nextCursor: null },
      }),
    })) as unknown as typeof fetch;

    const first = await searchOfficialRegistry("fs", 5, { fetchImpl });
    expect(first.servers).toHaveLength(1);
    expect(first.servers[0]?.suggestedName).toBe("fs");

    const second = await searchOfficialRegistry("fs", 5, { fetchImpl });
    expect(second.servers).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("网络失败：抛错而不是返回空列表（避免「假装没有结果」）", async () => {
    clearRegistryCache();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(searchOfficialRegistry("x", 5, { fetchImpl })).rejects.toThrow(
      /503/,
    );
  });

  it("检索词会作为 search 参数发出（官方只做名称子串匹配）", async () => {
    clearRegistryCache();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ servers: [], metadata: { count: 0 } }),
      };
    }) as unknown as typeof fetch;
    await searchOfficialRegistry("file system", 10, { fetchImpl });
    expect(calls[0]).toContain("search=file+system");
    expect(calls[0]).toContain("limit=10");
  });
});

describe("同名校验去重（同一 server 多版本）", () => {
  it("每条服务器只留一条：优先 isLatest，其次保留首个", () => {
    const mk = (version: string, isLatest: boolean) => ({
      server: {
        name: "com.example/fs",
        version,
        packages: [
          {
            registryType: "npm",
            identifier: "pkg",
            version,
            transportType: "stdio",
          },
        ],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { isLatest } },
    });

    const deduped = dedupeRegistryServers([
      toRegistryServerView(mk("0.1.2", false)),
      toRegistryServerView(mk("0.1.5", true)),
      toRegistryServerView(mk("0.1.3", false)),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.version).toBe("0.1.5");
    expect(deduped[0]?.isLatest).toBe(true);
  });

  it("没有 isLatest 标记时保留首个出现的（不猜版本大小）", () => {
    const view = (version: string) =>
      toRegistryServerView({
        server: { name: "com.example/x", version, packages: [] },
      });
    const deduped = dedupeRegistryServers([view("2.0.0"), view("1.0.0")]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.version).toBe("2.0.0");
  });
});
