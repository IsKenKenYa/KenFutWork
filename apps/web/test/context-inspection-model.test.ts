import { assemble } from "@kenfutwork/context-insights-ui/assemble";
import type {
  ContextRequestInput,
  ContextRequestSummary,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import {
  buildContextTimeline,
  inspectionStream,
} from "../src/components/workbench/zcode/host/contextInspectionModel.js";
import { readContextPart } from "../src/components/workbench/zcode/host/contextInspectionReader.js";

const summary = (
  sequence: number,
  agentCallId: string | null = null,
): ContextRequestSummary => ({
  id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  runId: "00000000-0000-4000-8000-000000000100",
  sequence,
  purpose: "agent",
  agentCallId,
  agentName: null,
  startedAt: "2026-11-15T01:00:00.000Z",
  endedAt: null,
  status: "running",
  model: "local",
  messageCount: 1,
  toolCount: null,
  inputCharacters: 1,
  outputCharacters: null,
  usage: null,
});
const input = (
  ...messages: string[]
): ContextRequestInput & {
  messages: [ContextRequestInput["messages"][number]];
} => ({
  messages: [messages.map((content) => ({ type: "human", data: { content } }))],
  tools: null,
  model: "local",
});

describe("冻结请求的 dsh-context 数据适配", () => {
  it("同名工具按同一批消息中的调用 ID 对应参数与结果", () => {
    const value: ContextRequestInput = {
      model: "local",
      tools: null,
      messages: [
        [
          {
            type: "ai",
            data: {
              content: "",
              tool_calls: [
                { id: "a", name: "read_file", args: { path: "first.txt" } },
                { id: "b", name: "read_file", args: { path: "second.txt" } },
              ],
            },
          },
          {
            type: "tool",
            data: { tool_call_id: "b", content: "找不到文件", status: "error" },
          },
          {
            type: "tool",
            data: { tool_call_id: "a", content: "文件正文", status: "success" },
          },
        ],
        [{ type: "tool", data: { tool_call_id: "b", content: "历史结果" } }],
      ],
    };
    const data = buildContextTimeline([{ summary: summary(1), input: value }]);
    const [, failed, succeeded, unmatched] = data.convNodes;
    expect(failed).toMatchObject({
      call: {
        name: "read_file",
        argsRaw: expect.stringContaining("second.txt"),
      },
      isError: true,
    });
    expect(succeeded).toMatchObject({
      call: {
        name: "read_file",
        argsRaw: expect.stringContaining("first.txt"),
      },
      isError: false,
    });
    expect(unmatched?.call).toBeUndefined();
    expect(unmatched?.isError).toBeUndefined();
    expect(data.timeline.nodes[1]).toMatchObject({
      tool: "read_file",
      err: true,
    });
  });

  it("旧请求的调用参数不会补到新请求失去来源的工具结果", () => {
    const call = {
      type: "ai",
      data: {
        content: "",
        tool_calls: [{ id: "read", name: "read_file", args: { path: "A" } }],
      },
    };
    const result = {
      type: "tool",
      data: { tool_call_id: "read", content: "结果", status: "error" },
    };
    const scope = { model: "local", tools: null };
    const data = buildContextTimeline([
      { summary: summary(1), input: { ...scope, messages: [[call, result]] } },
      {
        summary: summary(2),
        input: { ...scope, messages: [[result, call, call, result]] },
      },
    ]);
    const results = data.convNodes.filter(
      (node) => node.kind === "tool-result",
    );
    expect(results.map((node) => node.call?.name)).toEqual([
      "read_file",
      undefined,
      undefined,
    ]);
    expect(results.map((node) => node.isError)).toEqual([true, true, true]);
  });

  it("保留推理与图片块的实际类型", () => {
    const blocks = [
      { type: "reasoning", text: "计划" },
      { type: "text", text: "回答" },
      {
        type: "image_url",
        image_url: { url: "https://example.invalid/image.png" },
      },
    ];
    const value = input();
    value.messages = [[{ type: "ai", data: { content: blocks } }]];
    const data = buildContextTimeline([{ summary: summary(1), input: value }]);
    expect(data.convNodes[0]?.blocks).toEqual(blocks);
    expect(data.timeline.nodes[0]?.text).toBe("回答");
  });
  it("保留重复消息并准确重建移除后的历史请求", () => {
    const data = buildContextTimeline([
      { summary: summary(1), input: input("A", "A", "B") },
      { summary: summary(3), input: input("A", "C") },
      { summary: summary(4), input: input("A", "A", "B") },
    ]);
    expect(data.timeline.requests).toHaveLength(3);
    const visible = (index: number) => {
      const request = data.timeline.requests[index];
      if (!request) throw new Error("缺少请求记录");
      const seq = request.seq;
      return assemble(data.timeline, data.headers, seq).nodes.map(
        (node) => node.text,
      );
    };
    expect(visible(0)).toEqual(["A", "A", "B"]);
    expect(visible(1)).toEqual(["A", "C"]);
    expect(visible(2)).toEqual(["A", "A", "B"]);
    expect(data.timeline.requests.every((r) => r.prompt === undefined)).toBe(
      true,
    );
  });
  it("区分估算组成与真实供应商用量并保留工具 schema", () => {
    const record = summary(9);
    record.usage = { inputTokens: 123, outputTokens: 7, cachedInputTokens: 80 };
    const value = input("你好");
    value.messages[0].unshift({ type: "system", data: { content: "规则" } });
    value.tools = [
      {
        type: "function",
        function: { name: "read_file", parameters: { type: "object" } },
      },
    ];
    const data = buildContextTimeline([{ summary: record, input: value }]);
    expect(data.timeline.requests[0]).toMatchObject({
      prompt: 123,
      output: 7,
      cacheRead: 80,
    });
    expect(data.timeline.current.total).toBeLessThan(123);
    const header = data.headers.headers[0];
    if (!header) throw new Error("缺少请求头记录");
    expect(data.headerContent.get(header.seq)?.tools[0]).toMatchObject({
      name: "read_file",
      schema: { type: "object" },
    });
  });
  it("空请求与移除系统提示后不继承旧提示", () => {
    const first = input("A");
    first.messages[0].unshift({
      type: "system",
      data: { content: "之前的规则" },
    });
    const empty = input();
    const data = buildContextTimeline([
      { summary: summary(1), input: first },
      { summary: summary(2), input: empty },
    ]);
    const request = data.timeline.requests[1];
    if (!request) throw new Error("缺少第二条请求");
    const current = assemble(data.timeline, data.headers, request.seq);
    expect(current.nodes).toEqual([]);
    expect(current.system).toBeNull();
    expect(data.headerContent.get(current.header?.seq ?? -1)?.system).toBe("");
    expect(buildContextTimeline([]).timeline.current.total).toBe(0);
  });
  it("不同 Run、Agent 和用途不参与同一条比较曲线", () => {
    const parent = summary(1);
    const child = summary(2, "child-1");
    const review = { ...summary(4), purpose: "goal-evaluation" as const };
    const nextRun = {
      ...summary(3),
      runId: "00000000-0000-4000-8000-000000000101",
    };
    expect(
      inspectionStream([nextRun, child, parent, review], parent).map(
        (r) => r.sequence,
      ),
    ).toEqual([1]);
    expect(
      inspectionStream([nextRun, child, parent, review], review).map(
        (r) => r.sequence,
      ),
    ).toEqual([4]);
    expect(() =>
      buildContextTimeline([
        { summary: parent, input: input("A") },
        { summary: child, input: input("B") },
      ]),
    ).toThrow();
    expect(() =>
      buildContextTimeline([
        { summary: parent, input: input("A") },
        { summary: review, input: input("B") },
      ]),
    ).toThrow("请选择同一 Run、Agent 和用途的请求。");
  });
  it("正文按页读取且保留 Unicode", async () => {
    const text = "A😀中文B";
    const pages = text.split("");
    let calls = 0;
    const result = await readContextPart(
      async (_method, args) => {
        if (!args?.[0]) throw new Error("缺少读取参数");
        const offset = (args[0] as { offset: number }).offset;
        calls++;
        return {
          text: pages[offset],
          totalCharacters: text.length,
          nextOffset: offset + 1 < text.length ? offset + 1 : null,
        };
      },
      "task",
      "request",
      "input",
      new AbortController().signal,
    );
    expect(result).toBe(text);
    expect(calls).toBe(text.length);
  });
  it("取消与不前进的分页立即终止", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readContextPart(
        async () => {
          throw new Error("不应读取");
        },
        "t",
        "r",
        "input",
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      readContextPart(
        async () => ({ text: "", nextOffset: 0, totalCharacters: 4 }),
        "t",
        "r",
        "input",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});
