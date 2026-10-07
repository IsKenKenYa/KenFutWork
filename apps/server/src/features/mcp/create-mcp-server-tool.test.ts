import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { LocalInstanceService } from "../local-instance/types.js";
import { createCreateMcpServerTool } from "./create-mcp-server-tool.js";
import type { McpService } from "./mcp-service.js";

const ACTOR = { instanceId: "instance-1", accessClientId: null };
const CANVAS_ID = "canvas-1";

function makeDeps(
  overrides: {
    resolveInstance?: () => Promise<void>;
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
      localInstance: {
        resolve:
          overrides.resolveInstance ??
          (async () => ({
            instanceId: ACTOR.instanceId,
            dataDir: sandboxRoot,
          })),
      } as unknown as LocalInstanceService,
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
      { canvasId: CANVAS_ID, actor: ACTOR, instanceId: ACTOR.instanceId },
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
      { canvasId: CANVAS_ID, actor: ACTOR, instanceId: ACTOR.instanceId },
    )) as Record<string, unknown>;
    expect(explicit.command).toBe("bun");

    const inferred = (await tool.execute(
      { name: "y", path: "tools/srv.js" },
      { canvasId: CANVAS_ID, actor: ACTOR, instanceId: ACTOR.instanceId },
    )) as Record<string, unknown>;
    expect(inferred.command).toBe("node");
  });

  it("实例拒绝 / 缺画布 / 越界路径都如实拒绝，且不注册任何 server", async () => {
    const create = vi.fn(async () => ({
      id: "s",
      name: "s",
      command: "python",
    }));

    const denied = createCreateMcpServerTool(
      makeDeps({
        resolveInstance: async () => {
          throw new Error("实例不可用");
        },
        create,
      }).deps,
    );
    await expect(
      denied.execute(
        { name: "a", path: "mcp/a.py" },
        { canvasId: CANVAS_ID, actor: ACTOR, instanceId: ACTOR.instanceId },
      ),
    ).rejects.toThrow(/实例/);

    const ok = createCreateMcpServerTool(makeDeps({ create }).deps);
    await expect(
      ok.execute(
        { name: "a", path: "mcp/a.py" },
        { actor: ACTOR, instanceId: ACTOR.instanceId },
      ),
    ).rejects.toThrow(/画布/);
    await expect(
      ok.execute(
        { name: "a", path: "../../etc/passwd" },
        { canvasId: CANVAS_ID, actor: ACTOR, instanceId: ACTOR.instanceId },
      ),
    ).rejects.toThrow(/越出工作目录/);
    expect(create).not.toHaveBeenCalled();
  });
});
