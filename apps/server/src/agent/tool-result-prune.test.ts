import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  createToolResultPruneMiddleware,
  pruneToolResultText,
} from "./tool-result-prune.js";

const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function runMiddleware(
  middleware: unknown,
  messages: unknown[],
): Promise<{ messages: ToolMessage[] }> {
  const wrap = (
    middleware as {
      wrapModelCall: (
        req: unknown,
        handler: (req: unknown) => Promise<unknown>,
      ) => Promise<unknown>;
    }
  ).wrapModelCall.bind(middleware);
  return wrap({ messages }, async (request) =>
    request,
  ) as Promise<{ messages: ToolMessage[] }>;
}

describe("工具结果内联修剪", () => {
  it("低于预算时原样返回", () => {
    const text = "x".repeat(100);
    expect(pruneToolResultText(text, 500)).toEqual({
      text,
      pruned: false,
      removedChars: 0,
    });
  });

  it("恰好等于预算时不修剪", () => {
    const text = "x".repeat(500);
    expect(pruneToolResultText(text, 500).pruned).toBe(false);
  });

  it("超过一个字符就开始修剪，且结果不超出预算", () => {
    const text = "abcdefghij".repeat(100);
    const result = pruneToolResultText(text, 500);
    expect(result.pruned).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(500);
    expect(result.text.startsWith("abcdefghij")).toBe(true);
    expect(result.text.endsWith("abcdefghij")).toBe(true);
    expect(result.removedChars).toBeGreaterThan(0);
    expect(result.text).toContain("工具输出中间部分已省略");
  });

  it("保留头部与尾部原文", () => {
    const head = "HEAD".repeat(100);
    const middle = "M".repeat(5_000);
    const tail = "TAIL".repeat(100);
    const text = `${head}${middle}${tail}`;
    const result = pruneToolResultText(text, 800);
    const marker = result.text.indexOf("[工具输出中间部分已省略");
    expect(result.text.slice(0, marker)).toContain("HEAD");
    expect(result.text.slice(result.text.lastIndexOf("]") + 1)).toContain(
      "TAIL",
    );
    expect(result.text).not.toContain("MMMMM");
  });

  it("不拆坏 emoji 代理对", () => {
    const text = `${"😀".repeat(300)}${"#".repeat(2_000)}${"🎯".repeat(300)}`;
    const result = pruneToolResultText(text, 600);
    expect(LONE_HIGH.test(result.text)).toBe(false);
    expect(LONE_LOW.test(result.text)).toBe(false);
  });

  it("JSON 结果不修剪，避免破坏可解析性", () => {
    const payload = JSON.stringify({
      items: Array.from({ length: 200 }, (_, index) => ({
        index,
        title: "测试".repeat(5),
      })),
    });
    expect(payload.length).toBeGreaterThan(800);
    expect(pruneToolResultText(payload, 800).pruned).toBe(false);
  });

  it("以括号开头的非 JSON 文本照常修剪", () => {
    const text = `[不是 JSON ${"x".repeat(2_000)}`;
    expect(pruneToolResultText(text, 500).pruned).toBe(true);
  });

  it("预算过小或非法时不修剪", () => {
    const text = "x".repeat(1_000);
    expect(pruneToolResultText(text, 10).pruned).toBe(false);
    expect(pruneToolResultText(text, Number.NaN).pruned).toBe(false);
    expect(pruneToolResultText(text, Number.POSITIVE_INFINITY).pruned).toBe(
      false,
    );
  });

  it("空字符串不修剪", () => {
    expect(pruneToolResultText("", 500).pruned).toBe(false);
  });

  it("重复修剪保持稳定（已修剪文本再次进入不膨胀）", () => {
    const first = pruneToolResultText("y".repeat(10_000), 600).text;
    const second = pruneToolResultText(first, 600);
    expect(second.pruned).toBe(false);
    expect(first.length).toBeLessThanOrEqual(600);
  });
});

describe("旧图片卸载", () => {
  function imageMessage(source: string): HumanMessage {
    return new HumanMessage({
      content: [
        { type: "text", text: `查看 ${source}` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${source}` } },
      ] as never,
    });
  }

  it("只保留最近一张图片，较早图片换成文字占位", async () => {
    const first = imageMessage("first");
    const second = imageMessage("second");
    const third = imageMessage("third");
    const result = await runMiddleware(
      createToolResultPruneMiddleware(1_000, 1),
      [first, second, third],
    );
    const parts = result.messages as unknown as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    const firstPart = parts[0] as {
      content: Array<{ type: string; text?: string }>;
    };
    const secondPart = parts[1] as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(firstPart.content.map((part) => part.type)).toEqual([
      "text",
      "text",
    ]);
    expect(firstPart.content[0]?.text).toBe("查看 first");
    expect(firstPart.content[1]?.text).toContain("较早的图片已省略");
    expect(secondPart.content.map((part) => part.type)).toEqual([
      "text",
      "text",
    ]);
    const thirdPart = result.messages[2] as unknown as {
      content: Array<{ type: string }>;
    };
    expect(thirdPart.content.map((part) => part.type)).toEqual([
      "text",
      "image_url",
    ]);
    expect(result.messages[2]).toBe(third);
  });

  it("保留为零时卸载全部图片，并保留工具消息身份", async () => {
    const tool = new ToolMessage({
      content: [
        { type: "text", text: "截图结果" },
        { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
      ] as never,
      tool_call_id: "call-image",
      name: "Screenshot",
    });
    const result = await runMiddleware(
      createToolResultPruneMiddleware(1_000, 0),
      [tool],
    );
    const unloaded = result.messages[0] as unknown as {
      content: Array<{ type: string }>;
      tool_call_id: string;
      name: string;
    };
    expect(unloaded.content.map((part) => part.type)).toEqual([
      "text",
      "text",
    ]);
    expect(unloaded.tool_call_id).toBe("call-image");
    expect(unloaded.name).toBe("Screenshot");
  });

  it("图片张数未超限时不改写消息", async () => {
    const first = imageMessage("a");
    const second = imageMessage("b");
    const result = await runMiddleware(
      createToolResultPruneMiddleware(1_000, 2),
      [first, second],
    );
    expect(result.messages[0]).toBe(first);
    expect(result.messages[1]).toBe(second);
  });

  it("不认识的内容块与字符串消息保持原样", async () => {
    const human = new HumanMessage("纯文本");
    const result = await runMiddleware(
      createToolResultPruneMiddleware(1_000, 0),
      [human],
    );
    expect(result.messages[0]).toBe(human);
  });
});

describe("工具结果修剪中间件", () => {
  it("只修剪工具消息，人类与模型消息保持原样", async () => {
    const longText = "z".repeat(5_000);
    const human = new HumanMessage("请读取文件");
    const ai = new AIMessage(longText);
    const tool = new ToolMessage({
      content: longText,
      tool_call_id: "call-1",
      name: "Read",
    });
    const result = await runMiddleware(
      createToolResultPruneMiddleware(500),
      [human, ai, tool],
    );
    expect(result.messages[0]).toBe(human);
    expect(result.messages[1]).toBe(ai);
    const pruned = result.messages[2] as ToolMessage;
    expect((pruned.content as string).length).toBeLessThanOrEqual(500);
    expect(pruned.tool_call_id).toBe("call-1");
    expect(pruned.name).toBe("Read");
  });

  it("保留状态与结构化展示副本", async () => {
    const tool = new ToolMessage({
      content: "q".repeat(3_000),
      tool_call_id: "call-2",
      name: "Bash",
      status: "success",
    });
    tool.artifact = { exitCode: 0, stdout: "q".repeat(3_000) };
    const result = await runMiddleware(
      createToolResultPruneMiddleware(400),
      [tool],
    );
    const pruned = result.messages[0] as ToolMessage;
    expect(pruned.status).toBe("success");
    expect(pruned.artifact).toEqual({ exitCode: 0, stdout: "q".repeat(3_000) });
  });

  it("没有消息或预算未设置时直接交给后续处理", async () => {
    const middleware = createToolResultPruneMiddleware(100);
    const request = { messages: [] as unknown[] };
    await expect(
      (
        middleware as unknown as {
          wrapModelCall: (req: unknown, handler: (req: unknown) => Promise<unknown>) => Promise<unknown>;
        }
      ).wrapModelCall(request, async (value) => value),
    ).resolves.toEqual(request);
  });

  it("结构化内容（非字符串）不强行改写", async () => {
    const tool = new ToolMessage({
      content: [{ type: "text", text: "u".repeat(1_000) }] as never,
      tool_call_id: "call-3",
    });
    const result = await runMiddleware(
      createToolResultPruneMiddleware(100),
      [tool],
    );
    expect(result.messages[0]).toBe(tool);
  });
});
