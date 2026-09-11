// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExecutionModeSelect } from "../src/components/execution-mode-select";
import {
  fetchExecutionMode,
  fetchExecutionModes,
  updateExecutionMode,
} from "../src/lib/server-api";

const {
  fetchExecutionModesMock,
  fetchExecutionModeMock,
  updateExecutionModeMock,
} = vi.hoisted(() => ({
  fetchExecutionModesMock: vi.fn(),
  fetchExecutionModeMock: vi.fn(),
  updateExecutionModeMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchExecutionModes: fetchExecutionModesMock,
  fetchExecutionMode: fetchExecutionModeMock,
  updateExecutionMode: updateExecutionModeMock,
}));

const modes = [
  {
    id: "agent",
    label: "自主执行",
    description: "默认：agent 自主循环完成任务。",
  },
  {
    id: "plan",
    label: "先规划",
    description: "先产出分步计划待用户批准，再逐步执行。",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  fetchExecutionModesMock.mockResolvedValue({ modes });
  fetchExecutionModeMock.mockResolvedValue({ mode: "agent" });
  updateExecutionModeMock.mockResolvedValue({ mode: "plan" });
});

afterEach(() => {
  cleanup();
});

describe("ExecutionModeSelect（P7 执行模式切换 UI）", () => {
  it("加载模式词汇表与当前模式并渲染下拉", async () => {
    render(<ExecutionModeSelect accessToken="token" threadId="thread-1" />);
    const select = (await screen.findByLabelText(
      "执行模式",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("agent");
    });
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "自主执行",
      "先规划",
    ]);
  });

  it("模拟点击切换为 plan：发起 PUT 并保持选中", async () => {
    const user = userEvent.setup();
    render(<ExecutionModeSelect accessToken="token" threadId="thread-1" />);
    const select = (await screen.findByLabelText(
      "执行模式",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("agent");
    });

    await user.selectOptions(select, "plan");
    await waitFor(() => {
      expect(updateExecutionModeMock).toHaveBeenCalledWith(
        "token",
        "thread-1",
        { mode: "plan" },
      );
    });
    expect((select as HTMLSelectElement).value).toBe("plan");
  });

  it("PUT 失败回滚到原模式", async () => {
    updateExecutionModeMock.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    render(<ExecutionModeSelect accessToken="token" threadId="thread-1" />);
    const select = (await screen.findByLabelText(
      "执行模式",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("agent");
    });

    await user.selectOptions(select, "plan");
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("agent");
    });
  });

  it("端点不可用（加载失败）时隐藏切换器", async () => {
    fetchExecutionModesMock.mockRejectedValue(new Error("404"));
    render(<ExecutionModeSelect accessToken="token" threadId="thread-1" />);
    await waitFor(() => {
      expect(screen.queryByLabelText("执行模式")).toBeNull();
    });
  });
});
