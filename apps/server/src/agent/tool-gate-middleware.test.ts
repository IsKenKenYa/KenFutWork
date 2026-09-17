import { describe, expect, it } from "vitest";

import { createToolGateMiddleware } from "./deep-agent.js";

/**
 * 回归：工具门中间件必须把「拒绝」告诉旁路钩子。
 *
 * 此前门只回 ToolMessage，客户端拿不到任何 tool.* 事件——界面上完全没有
 * 「谁被拦了、为什么」的记录（用户直接看不到被拦的工具调用）。
 */
describe("工具门中间件的旁路钩子", () => {
  const middleware = (verdict: "allow" | "deny") =>
    createToolGateMiddleware(
      () =>
        verdict === "allow"
          ? { allowed: true as const }
          : {
              allowed: false as const,
              reason: "solo 对话模式：工具调用已禁用。",
            },
      hooks,
    );

  const denied: Array<Record<string, unknown>> = [];
  const allowed: string[] = [];
  const hooks = {
    onAllowed: (toolName: string) => allowed.push(toolName),
    onDenied: (entry: Record<string, unknown>) => denied.push(entry),
  };

  const request = (args: unknown) => ({
    tool: undefined,
    toolCall: {
      args,
      id: "call-42",
      name: "write_file",
    },
  });

  /** 调用中间件：注册即应提供 wrapToolCall，缺失时显式抛错（不用非空断言）。 */
  async function wrapToolCall(
    verdict: "allow" | "deny",
    req: unknown,
    handler: unknown,
  ): Promise<unknown> {
    const wrap = middleware(verdict).wrapToolCall;
    if (!wrap) {
      throw new Error("工具门中间件未提供 wrapToolCall");
    }
    return await wrap(req as never, handler as never);
  }

  it("拒绝时记下工具名/调用 id/参数，并回 ToolMessage 给模型", async () => {
    denied.length = 0;
    const handler = async () => {
      throw new Error("不该执行到真正的工具");
    };

    const result = (await wrapToolCall(
      "deny",
      request({ file_path: "a.txt" }),
      handler,
    )) as { content?: unknown };

    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      toolCallId: "call-42",
      toolName: "write_file",
      input: { file_path: "a.txt" },
    });
    expect(String(result.content)).toContain("被拒绝");
  });

  it("放行时通知 onAllowed（用于把连续计数清零）并执行真正的工具", async () => {
    allowed.length = 0;
    const result = await wrapToolCall(
      "allow",
      request({}),
      async () => "tool-output",
    );

    expect(allowed).toEqual(["write_file"]);
    expect(result).toBe("tool-output");
  });
});
