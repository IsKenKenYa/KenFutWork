import { describe, expect, it } from "vitest";
import type { ProductToolEvent } from "./tool-execution-receipts.js";
import { createToolExecutionReceipts } from "./tool-execution-receipts.js";

const RUN_ID = "run-receipts-fixture";
type Event = ProductToolEvent;

function event(
  partial: Partial<Event> & Pick<Event, "type" | "toolName" | "toolCallId">,
): Event {
  return {
    runId: RUN_ID,
    status: "success",
    timestamp: "2026-10-13T00:00:00.000Z",
    ...partial,
  } as unknown as Event;
}

function makeReceipts(projected: Event[] = []) {
  const published: Event[] = [];
  const receipts = createToolExecutionReceipts({
    runId: RUN_ID,
    project: async () => projected,
    publish: async (value) => {
      published.push(value);
    },
  });
  return { receipts, published };
}

describe("工具执行回执门：目录层自带 SDK 工具的豁免", () => {
  it("已观察的 SDK 工具（registered:false）成功完成事件不被内核回执校验误杀，且完成事实仍会下发", async () => {
    const { receipts, published } = makeReceipts();
    const started = event({
      type: "tool.started",
      toolName: "ToolSearch",
      toolCallId: "call_toolsearch",
    });
    const completed = event({
      type: "tool.completed",
      toolName: "ToolSearch",
      toolCallId: "call_toolsearch",
    });
    await receipts.observeNative({
      toolName: "ToolSearch",
      toolCallId: "call_toolsearch",
      registered: false,
      events: [started, completed],
    });
    // provider 流里的同一条完成事件先到一步——必须不抛。
    expect(() => receipts.gate.verify(completed)).not.toThrow();
    // 目录层自带的 SDK 工具确实会下发开始与完成两条事实。
    expect(published.map((item) => item.type)).toEqual([
      "tool.started",
      "tool.completed",
    ]);
  });

  it("未观察过的工具成功完成事件仍按内核回执严格校验（守卫不被削弱）", () => {
    const { receipts } = makeReceipts();
    const completed = event({
      type: "tool.completed",
      toolName: "Write",
      toolCallId: "call_write",
    });
    expect(() => receipts.gate.verify(completed)).toThrow(
      "工具成功事件缺少真实执行结果。",
    );
  });

  it("已注册（内核）工具回执齐备即通过；两侧都有内容且不一致仍被拦", async () => {
    const receipt = event({
      type: "tool.completed",
      toolName: "Write",
      toolCallId: "call_write",
      outputText: "真实结果",
    });
    const { receipts } = makeReceipts([receipt]);
    await receipts.observe({
      runId: RUN_ID,
      toolCallId: "call_write",
    } as unknown as Parameters<typeof receipts.observe>[0]);
    await receipts.observeNative({
      toolName: "Write",
      toolCallId: "call_write",
      registered: true,
      events: [receipt],
    });
    expect(() => receipts.gate.verify(receipt)).not.toThrow();
    const tampered = event({
      type: "tool.completed",
      toolName: "Write",
      toolCallId: "call_write",
      outputText: "伪造结果",
    });
    expect(() => receipts.gate.verify(tampered)).toThrow(
      "工具事件替换了真实执行结果。",
    );
  });

  it("宿主回执该字段为空时不判为替换（list_mcp_servers 实测：宿主 outputText=空、provider 带真实内容）", async () => {
    const receipt = event({
      type: "tool.completed",
      toolName: "list_mcp_servers",
      toolCallId: "call_list",
      outputText: "",
    });
    const { receipts } = makeReceipts([receipt]);
    await receipts.observe({
      runId: RUN_ID,
      toolCallId: "call_list",
    } as unknown as Parameters<typeof receipts.observe>[0]);
    await receipts.observeNative({
      toolName: "list_mcp_servers",
      toolCallId: "call_list",
      registered: true,
      events: [receipt],
    });
    const incoming = event({
      type: "tool.completed",
      toolName: "list_mcp_servers",
      toolCallId: "call_list",
      outputText: '[{"name":"kfwstats","status":"connected"}]',
    });
    expect(() => receipts.gate.verify(incoming)).not.toThrow();
  });

  it("失败的完成事件不需要回执（error/cancelled 通道保持原样）", () => {
    const { receipts } = makeReceipts();
    const failed = event({
      type: "tool.completed",
      toolName: "Write",
      toolCallId: "call_failed",
      status: "error",
    } as Partial<Event> & Pick<Event, "type" | "toolName" | "toolCallId">);
    expect(() => receipts.gate.verify(failed)).not.toThrow();
  });
});
