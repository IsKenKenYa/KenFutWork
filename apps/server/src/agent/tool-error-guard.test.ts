import { describe, expect, it } from "vitest";

import { createToolErrorGuardMiddleware } from "./deep-agent.js";

/**
 * 回归（2026-09-16 全流程走查实测）：工具执行失败此前会让**整轮 run 失败**。
 * 联网搜索上游偶发 5002 时，模型连「换关键词重搜」和「继续后面的步骤」的机会都没有。
 * 现在按工具级结果回给模型；同一个工具连续失败达上限后必须明确劝阻重试。
 */
describe("工具失败兜底中间件", () => {
  const request = (name: string, id = "call-1") => ({
    tool: undefined,
    toolCall: { args: {}, id, name },
  });

  it("工具抛错 → 回带原因的 ToolMessage，而不是让异常冒出去", async () => {
    const mw = createToolErrorGuardMiddleware();
    const handler = async () => {
      throw new Error("web_search 请求失败（上游 5002）");
    };
    const result = (await mw.wrapToolCall!(
      request("web_search") as never,
      handler as never,
    )) as { content?: unknown; status?: string; tool_call_id?: string };

    expect(String(result.content)).toContain("web_search 执行失败");
    expect(String(result.content)).toContain("5002");
    expect(result.tool_call_id).toBe("call-1");
    expect(result.status).toBe("error");
  });

  it("成功调用清掉连续失败计数", async () => {
    const mw = createToolErrorGuardMiddleware({ maxConsecutiveFailures: 2 });
    const fail = async () => {
      throw new Error("boom");
    };
    await mw.wrapToolCall!(request("web_search") as never, fail as never);
    await mw.wrapToolCall!(
      request("web_search") as never,
      (async () => "ok") as never,
    );
    const again = (await mw.wrapToolCall!(
      request("web_search") as never,
      fail as never,
    )) as { content?: unknown };
    // 计数已清零，所以这句是「第一次失败」的措辞，而不是连续失败上限的劝阻
    expect(String(again.content)).toContain("工具级失败");
    expect(String(again.content)).not.toContain("不要再重试");
  });

  it("同一工具连续失败达上限：明确要求停止重试", async () => {
    const mw = createToolErrorGuardMiddleware({ maxConsecutiveFailures: 2 });
    const fail = async () => {
      throw new Error("boom");
    };
    await mw.wrapToolCall!(request("web_search") as never, fail as never);
    const second = (await mw.wrapToolCall!(
      request("web_search") as never,
      fail as never,
    )) as { content?: unknown };
    expect(String(second.content)).toContain("不要再重试");
  });

  it("换工具重试不受别的工具的失败计数影响", async () => {
    const mw = createToolErrorGuardMiddleware({ maxConsecutiveFailures: 2 });
    const fail = async () => {
      throw new Error("boom");
    };
    await mw.wrapToolCall!(request("web_search") as never, fail as never);
    await mw.wrapToolCall!(request("web_search") as never, fail as never);
    const other = (await mw.wrapToolCall!(
      request("mcp__py-helper__add_numbers") as never,
      fail as never,
    )) as { content?: unknown };
    expect(String(other.content)).not.toContain("不要再重试");
  });
});
