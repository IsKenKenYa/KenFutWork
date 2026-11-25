import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));

const { ExecutionModeChipProbe: ExecutionModeChip } = await import(
  "./setup/execution-mode-chip.js"
);

/**
 * 用例只关心执行方式端点；合并后的菜单同时读写权限档，这里补默认 tier。
 *
 * `sessionId=null` 的草稿态首屏就该能选执行方式，所以 tier 必须在挂载时就能读到；
 * 读不到时整个触发器不渲染（不摆一个点了没反应的空按钮）。
 */
function mockApi(
  inner: (path: string, init?: RequestInit) => unknown | Promise<unknown>,
) {
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/permissions/tier") {
      if (init?.method === "PUT")
        return { tier: JSON.parse(String(init.body)).tier };
      return { tier: "default", automationTier: "default" };
    }
    return inner(path, init);
  });
}

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
});

test("权限与执行方式在同一个菜单里，执行方式只在真实策略加载后出现", async () => {
  mockApi(async (path: string) => {
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
  // 触发器写权限档；执行方式在同一菜单里，不再单独占一个按钮。
  await waitFor(() =>
    expect(
      screen.getByTestId("chat-mode-select-trigger").textContent,
    ).toContain("变更前确认"),
  );
  expect(screen.queryByTestId("execution-mode-chip")).toBeNull();

  rerender(<ExecutionModeChip sessionId="s1" disabled={false} />);
  // 执行方式生效后通过同一触发器上的锚点暴露（菜单内那组选项的当前值）。
  await waitFor(() =>
    expect(
      screen
        .getByTestId("chat-mode-select-trigger")
        .getAttribute("data-execution-mode"),
    ).toBe("goal"),
  );
  expect(screen.getByTestId("chat-mode-select-trigger").textContent).toContain(
    "变更前确认",
  );

  // 端点整体不可用：执行方式不可用，但权限档照常可选。
  mockApi(async () => {
    throw new Error("down");
  });
  rerender(<ExecutionModeChip sessionId="s2" disabled={false} />);
  await waitFor(() =>
    expect(
      screen
        .getByTestId("chat-mode-select-trigger")
        .getAttribute("data-execution-mode"),
    ).toBeNull(),
  );
  expect(screen.getByTestId("chat-mode-select-trigger").textContent).toContain(
    "变更前确认",
  );
});
