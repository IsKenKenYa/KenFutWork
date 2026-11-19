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

test("权限按钮与执行方式按钮并排，执行方式只在真实策略加载后出现", async () => {
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
  // 权限按钮只写权限档，不再把执行方式拼进自己的文案。
  expect(screen.getByTestId("chat-mode-select-trigger").textContent).toContain(
    "完全访问",
  );
  expect(screen.queryByTestId("execution-mode-chip")).toBeNull();

  rerender(<ExecutionModeChip sessionId="s1" disabled={false} />);
  await waitFor(() =>
    expect(screen.getByTestId("execution-mode-chip").textContent).toContain(
      "目标",
    ),
  );
  expect(screen.getByTestId("chat-mode-select-trigger").textContent).toContain(
    "完全访问",
  );

  surfaceJson.mockImplementation(async () => {
    throw new Error("down");
  });
  rerender(<ExecutionModeChip sessionId="s2" disabled={false} />);
  await waitFor(() =>
    expect(screen.queryByTestId("execution-mode-chip")).toBeNull(),
  );
  expect(screen.getByTestId("chat-mode-select-trigger").textContent).toContain(
    "完全访问",
  );
});
