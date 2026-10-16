import { describe, expect, it } from "vitest";
import {
  OwnedToolInterruption,
  TOOL_INTERRUPTION_SUMMARY,
} from "../kernel/owned-tool-interruption.js";
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
  it.each(["error", "cancelled"] as const)(
    "已注册工具在目录或中间层%s时发布可信拒绝事实，重复证明不重复发布",
    async (status) => {
      const { receipts, published } = makeReceipts();
      const started = event({
        type: "tool.started",
        toolName: "Write",
        toolCallId: "call_registered_denied",
        input: { file_path: "forbidden.txt", content: "must not write" },
      });
      const completed = event({
        type: "tool.completed",
        toolName: "Write",
        toolCallId: "call_registered_denied",
        status,
        outputSummary: "当前规划状态拒绝写入",
      });
      const proof = {
        toolName: "Write",
        toolCallId: "call_registered_denied",
        registered: true,
        events: [started, completed],
      };

      await receipts.observeNative(proof);
      expect(published).toEqual([started, completed]);
      expect(receipts.gate.drain()).toEqual([started, completed]);
      expect(receipts.gate.isExecuting()).toBe(false);

      await receipts.observeNative(proof);
      expect(published).toEqual([started, completed]);
      expect(receipts.gate.drain()).toEqual([]);
    },
  );

  it("已注册工具只有native成功证明而没有真实内核回执，仍拒绝并且不发布成功", async () => {
    const { receipts, published } = makeReceipts();
    await expect(
      receipts.observeNative({
        toolName: "Write",
        toolCallId: "call_unproven_success",
        registered: true,
        events: [
          event({
            type: "tool.started",
            toolName: "Write",
            toolCallId: "call_unproven_success",
          }),
          event({
            type: "tool.completed",
            toolName: "Write",
            toolCallId: "call_unproven_success",
          }),
        ],
      }),
    ).rejects.toThrow("工具成功事件缺少真实执行结果。");
    expect(published).toEqual([]);
    expect(receipts.gate.isExecuting()).toBe(false);
  });

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

  it.each(["success", "error"] as const)(
    "真实%s先完成，私有native迟到中断只去重且不放宽provider证明门",
    async (status) => {
      const actual = event({
        type: "tool.completed",
        toolName: "Write",
        toolCallId: "call_first_terminal",
        status,
        outputText: "先到的真实结论",
      });
      const { receipts, published } = makeReceipts([actual]);
      await receipts.observe({
        runId: RUN_ID,
        toolCallId: actual.toolCallId,
      } as unknown as Parameters<typeof receipts.observe>[0]);
      const cancelled = event({
        type: "tool.completed",
        toolName: "Write",
        toolCallId: actual.toolCallId,
        status: "cancelled",
        outputSummary: TOOL_INTERRUPTION_SUMMARY,
      });
      await receipts.observeNative({
        toolName: "Write",
        toolCallId: actual.toolCallId,
        registered: true,
        interruption: new OwnedToolInterruption(),
        events: [cancelled],
      });
      expect(published).toEqual([actual]);
      expect(receipts.gate.drain()).toEqual([actual]);
      expect(() => receipts.gate.verify(cancelled)).toThrow(
        "工具事件与真实执行身份或结果状态不一致。",
      );
    },
  );

  it.each([
    { label: "缺少私有来源", interruption: undefined },
    {
      label: "仅同名Error",
      interruption: Object.assign(new Error(TOOL_INTERRUPTION_SUMMARY), {
        name: "OwnedToolInterruption",
      }),
    },
    { label: "错误证明调用身份", header: { toolCallId: "another_call" } },
    { label: "错误证明工具名", header: { toolName: "another_tool" } },
    { label: "错误Run", change: { runId: "another_run" } },
    { label: "错误代理归因", change: { agentName: "another_agent" } },
    { label: "夹带业务输出", change: { output: { success: true } } },
    { label: "夹带结果文本", change: { outputText: "伪造结果" } },
    { label: "夹带产物", change: { artifacts: [] } },
    { label: "改写中断摘要", change: { outputSummary: "伪造摘要" } },
  ])("迟到取消$label仍保持严格结果验证", async (candidate) => {
    const actual = event({
      type: "tool.completed",
      toolName: "Write",
      toolCallId: "call_strict_terminal",
      outputText: "先到的真实结果",
    });
    const { receipts, published } = makeReceipts([actual]);
    await receipts.observe({
      runId: RUN_ID,
      toolCallId: actual.toolCallId,
    } as unknown as Parameters<typeof receipts.observe>[0]);
    const cancelled = event({
      type: "tool.completed",
      toolName: "Write",
      toolCallId: actual.toolCallId,
      status: "cancelled",
      outputSummary: TOOL_INTERRUPTION_SUMMARY,
      ...candidate.change,
    });
    await expect(
      receipts.observeNative({
        toolName: "Write",
        toolCallId: actual.toolCallId,
        registered: true,
        ...("interruption" in candidate
          ? candidate.interruption
            ? { interruption: candidate.interruption }
            : {}
          : { interruption: new OwnedToolInterruption() }),
        ...candidate.header,
        events: [cancelled],
      }),
    ).rejects.toThrow("工具事件与真实执行身份或结果状态不一致。");
    expect(published).toEqual([actual]);
  });
});
