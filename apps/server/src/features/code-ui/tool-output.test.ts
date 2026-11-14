import { describe, expect, it } from "vitest";
import {
  parseToolOutputRef,
  previewToolOutput,
  readUtf8Window,
  resolveToolOutputText,
} from "./tool-output.js";

describe("工具输出原文分页", () => {
  it("落在预算内时原样返回，不制造截断引用", () => {
    expect(previewToolOutput("短输出", 1_024, "run/tool")).toEqual({
      text: "短输出",
    });
  });

  it("超预算时保留头尾，标记与总字节数如实记录", () => {
    const text = `${"A".repeat(1_000)}${"Z".repeat(1_000)}`;
    const preview = previewToolOutput(text, 200, "run-1/tool-1");
    expect(preview.text.startsWith("A")).toBe(true);
    expect(preview.text.endsWith("Z")).toBe(true);
    expect(preview.text).toContain("\n…\n");
    expect(Buffer.byteLength(preview.text, "utf8")).toBeLessThanOrEqual(200);
    expect(preview.truncated).toEqual({
      totalBytes: Buffer.byteLength(text, "utf8"),
      ref: "run-1/tool-1",
    });
  });

  it("分页按字节窗口续读，nextOffset 表示下一段起点", () => {
    const text = "0123456789";
    const first = readUtf8Window(text, 0, 4);
    expect(first.text).toBe("0123");
    expect(first.totalBytes).toBe(10);
    expect(first.nextOffset).toBe(4);
    const second = readUtf8Window(text, first.nextOffset!, 4);
    expect(second.text).toBe("4567");
    expect(second.nextOffset).toBe(8);
    const last = readUtf8Window(text, second.nextOffset!, 4);
    expect(last.text).toBe("89");
    expect(last.nextOffset).toBeNull();
  });

  it("多字节字符不会被切一半，越界窗口返回空文", () => {
    const text = "汉".repeat(5);
    const first = readUtf8Window(text, 0, 4);
    expect(first.text).toBe("汉");
    expect(first.nextOffset).toBe(3);
    const second = readUtf8Window(text, first.nextOffset!, 4);
    expect(second.text).toBe("汉");
    const overflow = readUtf8Window(text, 999, 4);
    expect(overflow.text).toBe("");
    expect(overflow.nextOffset).toBeNull();
  });

  it("原文引用只接受 runId/toolCallId，畸形引用返回空", () => {
    expect(parseToolOutputRef("run-1/tool-1")).toEqual({
      runId: "run-1",
      toolCallId: "tool-1",
    });
    for (const ref of ["", "/", "run", "run/", "/tool", "a/b/c"])
      expect(parseToolOutputRef(ref)).toBeNull();
  });

  it("TaskOutput 使用 canonical 结果，其余走正文或摘要", () => {
    expect(
      resolveToolOutputText({
        type: "tool.completed",
        runId: "run",
        toolCallId: "tool",
        toolName: "TaskOutput",
        output: { display: { kind: "text", text: "页" } },
        timestamp: "2026-10-02T12:00:00.000Z",
      }),
    ).toBe(JSON.stringify({ display: { kind: "text", text: "页" } }));
    expect(
      resolveToolOutputText({
        type: "tool.completed",
        runId: "run",
        toolCallId: "tool",
        toolName: "Bash",
        outputText: "命令输出",
        outputSummary: "摘要",
        timestamp: "2026-10-02T12:00:00.000Z",
      }),
    ).toBe("命令输出");
    expect(
      resolveToolOutputText({
        type: "tool.completed",
        runId: "run",
        toolCallId: "tool",
        toolName: "Bash",
        outputSummary: "摘要",
        timestamp: "2026-10-02T12:00:00.000Z",
      }),
    ).toBe("摘要");
  });
});
