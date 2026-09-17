import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AdminService } from "../admin/admin-service.js";
import type { RequestAuthenticator } from "../auth/types.js";
import { createCreateMcpServerTool } from "./create-mcp-server-tool.js";
import type { McpService } from "./mcp-service.js";

const USER = {
  accessToken: "tok-1",
  email: "admin@test.kenfutwork.com",
  id: "u-admin",
  userMetadata: {},
};
const CANVAS_ID = "canvas-1";

function makeDeps(
  overrides: {
    requireAdmin?: () => Promise<void>;
    create?: (input: unknown) => Promise<unknown>;
  } = {},
) {
  const create =
    overrides.create ??
    (async (input: unknown) => ({
      id: "srv-1",
      name: (input as { name: string }).name,
      command: (input as { command: string }).command,
    }));
  const sandboxRoot = mkdtempSync(join(tmpdir(), "kfw-mcp-tool-"));
  return {
    sandboxRoot,
    deps: {
      service: { create } as unknown as McpService,
      auth: { authenticate: async () => USER } as RequestAuthenticator,
      admin: {
        isAdmin: async () => true,
        requireAdmin: overrides.requireAdmin ?? (async () => {}),
      } as unknown as AdminService,
      sandboxRoot,
    },
  };
}

describe("create_mcp_server 工具（创造模式的 MCP 产物）", () => {
  it(".py 脚本自动推断 python，并把沙箱内绝对路径作为第一个参数", async () => {
    const calls: unknown[] = [];
    const { deps } = makeDeps({
      create: async (input) => {
        calls.push(input);
        return { id: "srv-1", name: "py_tools", command: "python" };
      },
    });
    const tool = createCreateMcpServerTool(deps);

    const result = (await tool.execute(
      { name: "py_tools", path: "mcp/py_tools.py" },
      { canvasId: CANVAS_ID, accessToken: "tok-1" },
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ registered: true, command: "python" });
    const input = calls[0] as { args: string[]; enabled: boolean };
    expect(input.enabled).toBe(true);
    expect(input.args[0]).toContain("py_tools.py");
    expect(String(input.args[0])).toContain(CANVAS_ID);
  });

  it("显式 command 优先；.js 推断 node", async () => {
    const { deps } = makeDeps();
    const tool = createCreateMcpServerTool(deps);

    const explicit = (await tool.execute(
      { name: "x", path: "tools/srv.js", command: "bun" },
      { canvasId: CANVAS_ID, accessToken: "tok-1" },
    )) as Record<string, unknown>;
    expect(explicit.command).toBe("bun");

    const inferred = (await tool.execute(
      { name: "y", path: "tools/srv.js" },
      { canvasId: CANVAS_ID, accessToken: "tok-1" },
    )) as Record<string, unknown>;
    expect(inferred.command).toBe("node");
  });

  it("非管理员 / 缺画布 / 越界路径都如实拒绝，且不注册任何 server", async () => {
    const create = vi.fn(async () => ({
      id: "s",
      name: "s",
      command: "python",
    }));

    const denied = createCreateMcpServerTool(
      makeDeps({
        requireAdmin: async () => {
          throw new Error("forbidden");
        },
        create,
      }).deps,
    );
    await expect(
      denied.execute(
        { name: "a", path: "mcp/a.py" },
        { canvasId: CANVAS_ID, accessToken: "tok-1" },
      ),
    ).rejects.toThrow(/管理员/);

    const ok = createCreateMcpServerTool(makeDeps({ create }).deps);
    await expect(
      ok.execute({ name: "a", path: "mcp/a.py" }, { accessToken: "tok-1" }),
    ).rejects.toThrow(/画布/);
    await expect(
      ok.execute(
        { name: "a", path: "../../etc/passwd" },
        { canvasId: CANVAS_ID, accessToken: "tok-1" },
      ),
    ).rejects.toThrow(/越出工作目录/);
    expect(create).not.toHaveBeenCalled();
  });
});
