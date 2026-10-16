import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));

const { ExecutionModeChipProbe: ExecutionModeChip } = await import(
  "./setup/execution-mode-chip.js"
);

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
});

test("执行模式 chip：加载后显示当前模式，隐藏于草稿态与端点失败", async () => {
  surfaceJson.mockImplementation(async (path: string) => {
    if (path === "/api/execution-modes") {
      return {
        modes: [
          { id: "agent", label: "自主" },
          { id: "goal", label: "目标" },
        ],
      };
    }
    return { mode: "goal" };
  });
  const { rerender } = render(
    <ExecutionModeChip sessionId={null} disabled={false} />,
  );
  expect(screen.queryByTestId("execution-mode-chip")).toBeNull();

  rerender(<ExecutionModeChip sessionId="s1" disabled={false} />);
  await waitFor(() =>
    expect(screen.getByTestId("execution-mode-chip").textContent).toContain(
      "目标",
    ),
  );

  surfaceJson.mockImplementation(async () => {
    throw new Error("down");
  });
  rerender(<ExecutionModeChip sessionId="s2" disabled={false} />);
  await waitFor(() =>
    expect(screen.queryByTestId("execution-mode-chip")).toBeNull(),
  );
});
