import { describe, expect, it, vi } from "vitest";
import { parseMcpServers } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { ToolRegistry } from "../../kernel/types.js";
import {
  type McpClientLike,
  registerMcpServerTools,
  toKernelTool,
} from "./mcp-tools.js";

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
    const tool = toKernelTool("fs", readFileTool, client);
    expect(tool.name).toBe("mcp__fs__read_file");
    expect(tool.scope).toBe("design");
    const result = await tool.execute({ path: "/tmp/a" }, {});
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "read_file",
        arguments: { path: "/tmp/a" },
      },
      undefined,
    );
    expect(result).toEqual({ content: "called:read_file" });
  });

  it("registerMcpServerTools 把全部工具注册进内核注册表，disposer 注销", () => {
    const kernelHandle: ReturnType<typeof composePlugins> = composePlugins(
      {
        agentBackendMode: "state",
        agentModel: "m",
        port: 0,
        version: "t",
        webOrigin: "http://x",
      },
      [
        {
          name: "probe",
          inject: [],
          apply(ctx) {
            const registry: ToolRegistry = ctx.get("tools");
            const client: McpClientLike = {
              listTools: async () => ({ tools: [] }),
              callTool: async () => null,
            };
            const dispose = registerMcpServerTools(
              registry,
              "srv",
              [{ name: "a" }, { name: "b" }],
              client,
            );
            expect(
              registry
                .list()
                .map((t) => t.name)
                .sort(),
            ).toEqual(["mcp__srv__a", "mcp__srv__b"]);
            dispose();
            expect(registry.list("shared")).toHaveLength(0);
          },
        },
      ],
    );
    kernelHandle.dispose();
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
