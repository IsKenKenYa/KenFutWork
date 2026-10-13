import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));

const { ExecutionModeChip } = await import(
  "../src/components/workbench/zcode/host/ExecutionModeChip.js"
);

const MODES = {
  modes: [
    { id: "agent", label: "自主" },
    { id: "plan", label: "计划" },
    { id: "goal", label: "目标" },
    { id: "creative", label: "创造" },
  ],
};

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
});

test("执行模式 chip 菜单交互：PUT 写入、计划联动 plan、失败回退", async () => {
  let putFails = false;
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/execution-modes") return MODES;
    if (init?.method === "PUT") {
      if (putFails) throw new Error("denied");
      return {
        mode: (JSON.parse(String(init.body)) as { mode: string }).mode,
      };
    }
    return { mode: "agent" };
  });
  const onSwitchMode = vi.fn();
  render(
    <ExecutionModeChip
      sessionId="s1"
      disabled={false}
      onSwitchMode={onSwitchMode}
    />,
  );
  const chip = await screen.findByTestId("execution-mode-chip");
  expect(chip.textContent).toContain("自主");

  // 创造：PUT 生效，不干预 ZCode 协作档
  await userEvent.click(chip);
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: "创造" }),
  );
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/execution-modes/s1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ mode: "creative" }),
      }),
    ),
  );
  expect(onSwitchMode).not.toHaveBeenCalled();

  // 计划：联动把 ZCode 协作档切到 plan（Q6 合并规则）
  await userEvent.click(screen.getByTestId("execution-mode-chip"));
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: "计划" }),
  );
  await waitFor(() => expect(onSwitchMode).toHaveBeenCalledWith("plan"));

  // PUT 失败：回退显示原模式
  putFails = true;
  await userEvent.click(screen.getByTestId("execution-mode-chip"));
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: "目标" }),
  );
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenLastCalledWith(
      "/api/execution-modes/s1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ mode: "goal" }),
      }),
    ),
  );
  await waitFor(() =>
    expect(screen.getByTestId("execution-mode-chip").textContent).toContain(
      "计划",
    ),
  );
});
