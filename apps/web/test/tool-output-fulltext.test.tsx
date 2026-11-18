import type { CodeUiToolOutputResponse } from "@kenfutwork/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  readToolOutputTruncated,
  ToolOutputFullTextLink,
} from "../src/components/workbench/zcode/ToolCallBlocks/ToolOutputFullTextLink.js";

const TRUNCATED = { totalBytes: 12, ref: "run-1/tool-1" };

afterEach(() => {
  cleanup();
});

function renderLink(
  onReadToolOutput: (
    sessionId: string,
    ref: string,
    offset: number,
  ) => Promise<CodeUiToolOutputResponse>,
) {
  return render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <ToolOutputFullTextLink
        sessionId="session-1"
        truncated={TRUNCATED}
        onReadToolOutput={onReadToolOutput}
      />
    </ZCodeIntlProvider>,
  );
}

describe("工具卡查看原文", () => {
  it("正常取回时显示第一页正文与进度", async () => {
    const pages: CodeUiToolOutputResponse[] = [
      { text: "完整正文", totalBytes: 12, nextOffset: null },
    ];
    renderLink(async (_sessionId, _ref, offset) => {
      expect(offset).toBe(0);
      const page = pages[0];
      if (!page) {
        throw new Error("缺少第一页");
      }
      return page;
    });

    fireEvent.click(screen.getByTestId("tool-output-fulltext-open"));

    expect(
      await screen.findByTestId("tool-output-fulltext-dialog"),
    ).toBeTruthy();
    expect(await screen.findByText("完整正文")).toBeTruthy();
    expect(screen.queryByText("继续加载")).toBeNull();
  });

  it("分段加载按 nextOffset 续读并拼接正文", async () => {
    const pages: CodeUiToolOutputResponse[] = [
      { text: "上半段", totalBytes: 12, nextOffset: 6 },
      { text: "下半段", totalBytes: 12, nextOffset: null },
    ];
    const offsets: number[] = [];
    renderLink(async (_sessionId, _ref, offset) => {
      offsets.push(offset);
      const page = pages[offsets.length - 1];
      if (!page) {
        throw new Error("缺少分页结果");
      }
      return page;
    });

    fireEvent.click(screen.getByTestId("tool-output-fulltext-open"));
    expect(await screen.findByText("上半段")).toBeTruthy();

    fireEvent.click(screen.getByText("继续加载"));

    expect(await screen.findByText("上半段下半段")).toBeTruthy();
    expect(offsets).toEqual([0, 6]);
    expect(screen.queryByText("继续加载")).toBeNull();
  });

  it("读取失败保留弹层并显示服务端原因", async () => {
    renderLink(async () => {
      throw new Error("Task 已归档，请取消归档后查看原文。");
    });

    fireEvent.click(screen.getByTestId("tool-output-fulltext-open"));

    expect(
      await screen.findByText("Task 已归档，请取消归档后查看原文。"),
    ).toBeTruthy();
    expect(screen.getByTestId("tool-output-fulltext-dialog")).toBeTruthy();
  });

  it("权限失效显示可读原因且不出现正文", async () => {
    renderLink(async () => {
      throw new Error("无权查看该会话的工具输出。");
    });

    fireEvent.click(screen.getByTestId("tool-output-fulltext-open"));

    expect(await screen.findByText("无权查看该会话的工具输出。")).toBeTruthy();
    expect(screen.queryByText("完整正文")).toBeNull();
  });
});

describe("readToolOutputTruncated", () => {
  it("读取合法截断引用", () => {
    expect(
      readToolOutputTruncated({
        outputTruncated: { totalBytes: 2048, ref: "run/tool" },
      }),
    ).toEqual({ totalBytes: 2048, ref: "run/tool" });
  });

  it("拒绝缺失与畸形引用", () => {
    expect(readToolOutputTruncated(null)).toBeNull();
    expect(readToolOutputTruncated({})).toBeNull();
    expect(
      readToolOutputTruncated({ outputTruncated: { totalBytes: 0, ref: "a" } }),
    ).toBeNull();
    expect(
      readToolOutputTruncated({
        outputTruncated: { totalBytes: 1, ref: "  " },
      }),
    ).toBeNull();
  });
});
