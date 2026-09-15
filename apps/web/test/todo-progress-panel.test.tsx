// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { TodoProgressPanel } from "../src/components/workbench/todo-progress-panel";

afterEach(() => {
  cleanup();
});

const items = [
  { content: "读契约", status: "completed" as const },
  { content: "改服务端", status: "in_progress" as const },
  { content: "补测试", status: "pending" as const },
];

describe("TodoProgressPanel（目标 + 进度）", () => {
  it("显示目标、进度分子/分母与逐条状态", () => {
    render(<TodoProgressPanel goal="把参考图未做项补齐" items={items} running />);
    expect(screen.getByText("目标")).toBeInTheDocument();
    expect(screen.getByText("把参考图未做项补齐")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByText(/· 进行中 1$/)).toBeInTheDocument();
    expect(screen.getByText(/已完成 1$/)).toBeInTheDocument();
    expect(screen.getByText("改服务端")).toBeInTheDocument();
    expect(screen.getByText("补测试")).toBeInTheDocument();
  });

  it("已完成项默认折叠，点开才列出（不是删掉）", async () => {
    render(<TodoProgressPanel goal="目标" items={items} running={false} />);
    expect(screen.queryByText("读契约")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /已完成 1 项/ }));
    expect(screen.getByText("读契约")).toBeInTheDocument();
  });

  it("全部完成：目标行标「已完成」，停止后不再写「进行中」", () => {
    render(
      <TodoProgressPanel
        goal="目标"
        items={[{ content: "a", status: "completed" }]}
        running={false}
      />,
    );
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.queryByText("进行中")).not.toBeInTheDocument();
  });

  it("空待办表不渲染面板（模型没用 write_todos 就不出现空壳）", () => {
    const { container } = render(
      <TodoProgressPanel goal="目标" items={[]} running />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
