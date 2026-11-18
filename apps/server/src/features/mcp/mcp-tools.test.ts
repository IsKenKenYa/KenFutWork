import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMcpServers } from "../../config/env.js";
import {
  assertMcpContribution,
  type McpClientLike,
  mcpConfigurationVersion,
  registerMcpServerTools,
  toKernelTool,
} from "./mcp-tools.js";

import { taskMcpFixture } from "./test-task-mcp-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const fixture = () => taskMcpFixture({}, (cleanup) => cleanups.push(cleanup));

describe("MCP 工具注册（P4d）", () => {
  it("工具按 mcp__<server>__<tool> 命名，execute 透传 callTool", async () => {
    const callTool = vi.fn(async (args: { name: string }) => ({
      content: `called:${args.name}`,
    }));
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool,
    };
    const readFileTool = (await client.listTools()).tools[0];
    if (!readFileTool) {
      throw new Error("桩客户端未返回工具定义");
    }
    const f = await fixture();
    const tool = toKernelTool("fs", readFileTool, client);
    expect(tool.name).toBe("mcp__fs__read_file");
    expect(tool.scope).toBe("shared");
    const result = await tool.execute({ path: "/tmp/a" }, f.context);
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "read_file",
        arguments: { path: "/tmp/a" },
      },
      undefined,
      f.context,
    );
    expect(result).toEqual({ content: "called:read_file" });
  });

  it("实例MCP按真实Task动态注册，两个模式均共享，缺工作域和只读角色不曝光", async () => {
    const f = await fixture();
    const dispose = registerMcpServerTools(
      f.registry,
      "srv",
      [{ name: "a" }, { name: "b" }],
      {
        listTools: async () => ({ tools: [] }),
        callTool: async () => null,
      },
      "configuration-1",
    );
    for (const preset of ["code", "design"] as const) {
      expect(
        f.registry
          .resolveRunTools({ ...f.resolution(), preset })
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(["mcp__srv__a", "mcp__srv__b"]);
      expect(
        f.registry.resolveRunTools({
          ...f.resolution(),
          preset,
          scopeHandle: undefined,
        }),
      ).toEqual([]);
      expect(
        f.registry.resolveRunTools({
          ...f.resolution(),
          preset,
          scopeHandle: f.handle.derive("explore", "reader"),
        }),
      ).toEqual([]);
    }
    dispose();
    expect(f.registry.resolveRunTools(f.resolution())).toEqual([]);
  });

  it("冻结摘要稳定且不含凭据；相同factory下改配置或schema均撤掉旧Run能力", async () => {
    const f = await fixture();
    const client = {
      listTools: async () => ({ tools: [] }),
      callTool: vi.fn(async () => null),
    };
    const config = {
      command: "node",
      args: ["server.mjs"],
      env: { TOKEN: "private-value" },
    };
    const version = mcpConfigurationVersion(config);
    expect(
      mcpConfigurationVersion({
        env: config.env,
        args: config.args,
        command: config.command,
      }),
    ).toBe(version);
    let dispose = registerMcpServerTools(
      f.registry,
      "srv",
      [{ name: "a", inputSchema: { type: "object" } }],
      client,
      version,
    );
    const frozenContributions = f.registry.captureContributions("design");
    expect(() =>
      assertMcpContribution(f.registry, "mcp:instance:mcp__srv__a", {
        ...f.context,
        frozenContributions,
      }),
    ).not.toThrow();
    expect(JSON.stringify(frozenContributions)).not.toContain("private-value");
    dispose();
    dispose = registerMcpServerTools(
      f.registry,
      "srv",
      [{ name: "a", inputSchema: { type: "object" } }],
      client,
      mcpConfigurationVersion({ ...config, env: { TOKEN: "changed" } }),
    );
    expect(() =>
      assertMcpContribution(f.registry, "mcp:instance:mcp__srv__a", {
        ...f.context,
        frozenContributions,
      }),
    ).toThrow("MCP工具或配置已改变");
    expect(
      f.registry.resolveRunTools({
        ...f.resolution(),
        preset: "design",
        frozenContributions,
      }),
    ).toEqual([]);
    dispose();
    registerMcpServerTools(
      f.registry,
      "srv",
      [{ name: "a", inputSchema: { type: "object", required: ["changed"] } }],
      client,
      version,
    );
    expect(
      f.registry.resolveRunTools({
        ...f.resolution(),
        preset: "design",
        frozenContributions,
      }),
    ).toEqual([]);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("parseMcpServers：空配置返回 undefined，非法结构 fail loud", () => {
    expect(parseMcpServers(undefined)).toBeUndefined();
    expect(parseMcpServers("")).toBeUndefined();
    expect(() => parseMcpServers("not-json")).toThrow();
    expect(() => parseMcpServers("{}")).toThrow(/JSON array/);
    expect(() => parseMcpServers('[{"name":"x"}]')).toThrow(/name and command/);
    const parsed = parseMcpServers(
      '[{"name":"fs","command":"npx","args":["-y","pkg"]}]',
    );
    expect(parsed).toEqual([
      { name: "fs", command: "npx", args: ["-y", "pkg"] },
    ]);
  });
});
