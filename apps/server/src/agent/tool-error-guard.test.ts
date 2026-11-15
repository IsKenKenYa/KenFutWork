import { ToolMessage } from "@langchain/core/messages";
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
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

  /**
   * 调用中间件的 wrapToolCall：注册中间件即应提供该方法，
   * 缺失时显式抛错（而不是靠非空断言把编译期假设带进运行时）。
   */
  async function wrapToolCall(
    middleware: ReturnType<typeof createToolErrorGuardMiddleware>,
    req: unknown,
    handler: unknown,
  ): Promise<{ content?: unknown; status?: string; tool_call_id?: string }> {
    const wrap = middleware.wrapToolCall;
    if (!wrap) {
      throw new Error("工具失败兜底中间件未提供 wrapToolCall");
    }
    return (await wrap(req as never, handler as never)) as {
      content?: unknown;
      status?: string;
      tool_call_id?: string;
    };
  }

  it("工具抛错 → 回带原因的 ToolMessage，而不是让异常冒出去", async () => {
    const mw = createToolErrorGuardMiddleware();
    const handler = async () => {
      throw new Error(
        "web_search 请求失败（上游 5002） Bearer test-secret-value",
      );
    };
    const result = await wrapToolCall(mw, request("web_search"), handler);

    expect(String(result.content)).toContain("web_search 执行失败");
    expect(String(result.content)).toContain("5002");
    expect(String(result.content)).not.toContain("test-secret-value");
    expect(result.tool_call_id).toBe("call-1");
    expect(result.status).toBe("error");
  });

  it("成功调用清掉连续失败计数", async () => {
    const mw = createToolErrorGuardMiddleware({ maxConsecutiveFailures: 2 });
    const fail = async () => {
      throw new Error("boom");
    };
    await wrapToolCall(mw, request("web_search"), fail);
    await wrapToolCall(mw, request("web_search"), async () => "ok");
    const again = await wrapToolCall(mw, request("web_search"), fail);
    // 计数已清零，所以这句是「第一次失败」的措辞，而不是连续失败上限的劝阻
    expect(String(again.content)).toContain("工具级失败");
    expect(String(again.content)).not.toContain("不要再重试");
  });

  it("同一工具连续失败达上限：明确要求停止重试", async () => {
    const mw = createToolErrorGuardMiddleware({ maxConsecutiveFailures: 2 });
    const fail = async () => {
      throw new Error("boom");
    };
    await wrapToolCall(mw, request("web_search"), fail);
    const second = await wrapToolCall(mw, request("web_search"), fail);
    expect(String(second.content)).toContain("不要再重试");
  });

  it("返回式失败与异常共用计数，保留原工具结果和调用身份", async () => {
    const mw = createToolErrorGuardMiddleware({ maxConsecutiveFailures: 2 });
    await wrapToolCall(mw, request("generate_image"), async () => {
      throw new Error("供应商暂不可用");
    });
    const original = new ToolMessage({
      name: "generate_image",
      tool_call_id: "render-2",
      status: "error",
      content: [{ type: "text", text: "生成结果保存失败" }],
      artifact: { canonicalOutput: { jobId: "job-2" } },
    });
    const reported = await wrapToolCall(
      mw,
      request("generate_image", "render-2"),
      async () => original,
    );
    expect(reported).toMatchObject({
      name: "generate_image",
      tool_call_id: "render-2",
      status: "error",
      artifact: { canonicalOutput: { jobId: "job-2" } },
      content: [
        { type: "text", text: "生成结果保存失败" },
        { type: "text", text: expect.stringContaining("不要再重试") },
      ],
    });
    expect(original.content).toEqual([
      { type: "text", text: "生成结果保存失败" },
    ]);
  });

  it("LangGraph 审批可以暂停和恢复，暂停不产生工具错误", async () => {
    const mw = createToolErrorGuardMiddleware();
    const graph = new StateGraph(
      Annotation.Root({ result: Annotation<string>() }),
    )
      .addNode("tool", async () => {
        const message = await wrapToolCall(
          mw,
          request("write_file"),
          async () => {
            const approval: string = interrupt("是否保存文件？");
            return new ToolMessage({
              content: approval,
              tool_call_id: "call-1",
            });
          },
        );
        return { result: String(message.content) };
      })
      .addEdge(START, "tool")
      .addEdge("tool", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "approval" } };
    await expect(
      graph.invoke({ result: "等待审批" }, config),
    ).resolves.toMatchObject({
      result: "等待审批",
      __interrupt__: [{ value: "是否保存文件？" }],
    });
    await expect(
      graph.invoke(new Command({ resume: "已批准" }), config),
    ).resolves.toEqual({
      result: "已批准",
    });
  });

  it("换工具重试不受别的工具的失败计数影响", async () => {
    const mw = createToolErrorGuardMiddleware({ maxConsecutiveFailures: 2 });
    const fail = async () => {
      throw new Error("boom");
    };
    await wrapToolCall(mw, request("web_search"), fail);
    await wrapToolCall(mw, request("web_search"), fail);
    const other = await wrapToolCall(
      mw,
      request("mcp__py-helper__add_numbers"),
      fail,
    );
    expect(String(other.content)).not.toContain("不要再重试");
  });
});
