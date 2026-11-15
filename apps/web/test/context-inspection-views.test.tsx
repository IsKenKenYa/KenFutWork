import { Modal } from "@kenfutwork/context-insights-ui";
import type { ContextRequestSummary } from "@kenfutwork/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { mountContextInspectionIcons } from "../src/components/workbench/zcode/host/contextInspectionIcons.js";
import { buildContextTimeline } from "../src/components/workbench/zcode/host/contextInspectionModel.js";
import { ContextInspectionViews } from "../src/components/workbench/zcode/host/contextInspectionViews.js";

afterEach(cleanup);
const record: ContextRequestSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000100",
  sequence: 7,
  purpose: "agent",
  agentCallId: null,
  agentName: null,
  startedAt: "2026-11-15T01:00:00.000Z",
  endedAt: null,
  status: "running",
  model: "local",
  messageCount: 1,
  toolCount: 1,
  inputCharacters: 1,
  outputCharacters: null,
  usage: { inputTokens: 321, outputTokens: 8 },
};
const data = buildContextTimeline([
  {
    summary: record,
    input: {
      model: "local",
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        },
      ],
      messages: [[{ type: "human", data: { content: '{"path":"src"}' } }]],
    },
  },
]);

describe("dsh-context 原界面接入", () => {
  it("打开工具结果可查看原调用参数与失败状态", async () => {
    const timeline = buildContextTimeline([
      {
        summary: record,
        input: {
          model: "local",
          tools: null,
          messages: [
            [
              {
                type: "ai",
                data: {
                  content: "",
                  tool_calls: [
                    {
                      id: "read-1",
                      name: "read_file",
                      args: { path: "missing.txt" },
                    },
                  ],
                },
              },
              {
                type: "tool",
                data: {
                  tool_call_id: "read-1",
                  content: "找不到指定文件",
                  status: "error",
                },
              },
            ],
          ],
        },
      },
    ]);
    render(
      <ContextInspectionViews
        data={timeline}
        requestId={record.id}
        onSelect={() => {}}
      />,
    );
    const group = screen
      .getAllByRole("button", { name: /工具结果/ })
      .find((item) => item.hasAttribute("aria-expanded"));
    if (!group) throw new Error("工具结果入口缺失");
    fireEvent.click(group);
    const button = await screen.findByRole("button", {
      name: /read_file.*missing\.txt/,
    });
    if (button.getAttribute("aria-expanded") === "false")
      fireEvent.click(button);
    expect(await screen.findByText("失败")).toBeTruthy();
    expect(screen.getByText("path")).toBeTruthy();
    expect(screen.getByText("找不到指定文件")).toBeTruthy();
  });

  it("显示真实供应商读数与原分类浏览器", () => {
    render(
      <ContextInspectionViews
        data={data}
        requestId={record.id}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "已读取请求趋势" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("查看趋势数据"));
    const table = screen.getByRole("table", { name: "请求上下文" });
    expect(within(table).getByRole("cell", { name: "321" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "8" })).toBeTruthy();
    expect(screen.getAllByText("用户消息").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/请求 #7/).length).toBeGreaterThan(0);
    expect(screen.queryByText("比前轮")).toBeNull();
    expect(screen.queryByRole("button", { name: /第 0 轮/ })).toBeNull();
  });
  it("原始 JSON 组件与工具 schema 可以展开", async () => {
    function Example() {
      const [open, setOpen] = useState(true);
      return (
        <Modal
          headless
          open={open}
          title="上下文分析"
          onClose={() => setOpen(false)}
        >
          <ContextInspectionViews
            data={data}
            requestId={record.id}
            onSelect={() => {}}
          />
        </Modal>
      );
    }
    render(<Example />);
    const toggle = screen
      .getAllByRole("button", { name: /工具定义/ })
      .find((item) => item.hasAttribute("aria-expanded"));
    if (!toggle) throw new Error("工具定义入口缺失");
    fireEvent.click(toggle);
    expect(await screen.findByText("read_file")).toBeTruthy();
    const userToggle = screen
      .getAllByRole("button", { name: /用户消息/ })
      .find((item) => item.hasAttribute("aria-expanded"));
    if (!userToggle) throw new Error("用户消息入口缺失");
    fireEvent.click(userToggle);
    const tree = await screen.findByRole("tree", { name: "JSON 内容" });
    await userEvent.hover(within(tree).getByRole("treeitem"));
    const copy = screen.getAllByRole("button", { name: "复制值" })[0];
    if (!copy) throw new Error("JSON 复制入口缺失");
    fireEvent.contextMenu(copy);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("复制属性路径")).toBeTruthy();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "上下文分析" })).toBeTruthy();
  });
  it("安装真实图标 symbol 并在关闭时清理", () => {
    const dispose = mountContextInspectionIcons();
    render(
      <ContextInspectionViews
        data={data}
        requestId={record.id}
        onSelect={() => {}}
      />,
    );
    const uses = [...document.querySelectorAll("use")];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      const href = use.getAttribute("href");
      if (href?.startsWith("#"))
        expect(document.getElementById(href.slice(1))?.tagName).toBe("symbol");
    }
    dispose();
    expect(
      document.querySelector("[data-context-inspection-icons]"),
    ).toBeNull();
  });
  it("原 Modal 支持 Escape 关闭并恢复入口焦点", () => {
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            查看上下文
          </button>
          <Modal
            headless
            open={open}
            title="上下文分析"
            onClose={() => setOpen(false)}
          >
            <button type="button">关闭</button>
          </Modal>
        </>
      );
    }
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "查看上下文" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "上下文分析" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
