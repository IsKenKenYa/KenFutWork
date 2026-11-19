import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));

const { ExecutionModeChipProbe: ExecutionModeChip, readyComposerModeTrigger } =
  await import("./setup/execution-mode-chip.js");

const MODES = {
  modes: [
    { id: "agent", label: "自主" },
    { id: "plan", label: "计划" },
    { id: "goal", label: "目标" },
    { id: "creative", label: "创造" },
  ],
};

async function openModeMenu(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByTestId("chat-mode-select-trigger");
  await waitFor(() =>
    expect(trigger.getAttribute("aria-expanded")).toBe("false"),
  );
  act(() => trigger.focus());
  await user.keyboard("[Space]");
  await screen.findByRole("menu");
}

afterEach(() => {
  cleanup();
  // JSDOM移除焦点节点后把Document保留为旧焦点；下次focus会发出伪window.blur。
  // 通过公开focus/blur清理本例的焦点，不修改Radix真实的窗口失焦关层行为。
  const focusReset = document.createElement("button");
  document.body.append(focusReset);
  focusReset.focus();
  focusReset.blur();
  focusReset.remove();
  surfaceJson.mockReset();
});

test("离开计划策略只关闭规划开关，保留原基础权限", async () => {
  const user = userEvent.setup();
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/execution-modes") return MODES;
    if (init?.method === "PUT") return JSON.parse(String(init.body));
    return { mode: "plan" };
  });
  const onSwitchMode = vi.fn();
  render(
    <ExecutionModeChip
      sessionId="task"
      disabled={false}
      onSwitchMode={onSwitchMode}
    />,
  );
  await user.click(await readyComposerModeTrigger());
  await user.click(await screen.findByRole("menuitemradio", { name: "自主" }));
  await waitFor(() => expect(onSwitchMode).toHaveBeenCalledWith("plan-off"));
  expect(onSwitchMode.mock.calls).toEqual([["plan-off"]]);
});

test("原盾牌菜单：执行方式写入、唯一计划入口联动、失败回退", async () => {
  const user = userEvent.setup();
  const onExecutionModeChange = vi.fn();
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
      onExecutionModeChange={onExecutionModeChange}
    />,
  );
  const chip = await readyComposerModeTrigger();
  expect(chip.textContent).toContain("自主");

  // 创造：PUT 生效，不干预 ZCode 协作档
  await user.click(chip);
  await user.click(await screen.findByRole("menuitemradio", { name: "创造" }));
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
  expect(onExecutionModeChange).toHaveBeenLastCalledWith("creative");

  // 计划：联动把 ZCode 协作档切到 plan（Q6 合并规则）
  await openModeMenu(user);
  await user.click(await screen.findByRole("menuitemradio", { name: "计划" }));
  await waitFor(() => expect(onSwitchMode).toHaveBeenCalledWith("plan"));
  expect(onExecutionModeChange).toHaveBeenLastCalledWith("plan");

  // PUT 失败：回退显示原模式
  putFails = true;
  await openModeMenu(user);
  await user.click(await screen.findByRole("menuitemradio", { name: "目标" }));
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
    expect(
      screen.getByTestId("chat-mode-select-trigger").textContent,
    ).toContain("计划"),
  );
  expect(onExecutionModeChange).toHaveBeenLastCalledWith("plan");
});

test("权限与执行方式（含计划）只有原盾牌一个入口，全权保留原橙色图标", async () => {
  const user = userEvent.setup();
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/execution-modes") return MODES;
    if (init?.method === "PUT") return JSON.parse(String(init.body));
    return { mode: "agent" };
  });
  const onSwitchMode = vi.fn();
  render(
    <ExecutionModeChip
      sessionId="single-menu"
      disabled={false}
      onSwitchMode={onSwitchMode}
    />,
  );
  const trigger = await readyComposerModeTrigger();
  expect(trigger.className).toContain("text-warning");
  expect(trigger.querySelector("svg.lucide-shield-alert")).not.toBeNull();
  expect(screen.queryByTestId("execution-mode-chip")).toBeNull();
  expect(screen.queryByTestId("permission-tier-chip")).toBeNull();
  expect(screen.getAllByTestId("chat-mode-select-trigger")).toHaveLength(1);
  await user.click(trigger);
  const permissions = screen.getByRole("group", { name: "权限" });
  const executionModes = screen.getByRole("group", { name: "执行方式" });
  for (const [label, icon] of [
    ["自主", "bot"],
    ["计划", "lightbulb"],
    ["目标", "target"],
    ["创造", "puzzle"],
  ] as const) {
    const item = screen.getByRole("menuitemradio", { name: label });
    expect(item.querySelector(`svg.lucide-${icon}`)).not.toBeNull();
    expect(executionModes.contains(item)).toBe(true);
  }
  expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
  expect(screen.getByRole("menu").textContent).toContain("人工或审批模型");
  expect(
    permissions.contains(
      screen.getByRole("menuitemradio", { name: /^变更前确认/ }),
    ),
  ).toBe(true);
  await user.click(screen.getByRole("menuitemradio", { name: /^变更前确认/ }));
  expect(onSwitchMode).toHaveBeenLastCalledWith("build");
  expect(trigger.textContent).toContain("自主");
  expect(trigger.textContent).toContain("变更前确认");
  expect(trigger.className).not.toContain("text-warning");
  await openModeMenu(user);
  await user.click(screen.getByRole("menuitemradio", { name: /^完全访问/ }));
  expect(onSwitchMode).toHaveBeenLastCalledWith("yolo");
  expect(trigger.querySelector("svg.lucide-shield-alert")).not.toBeNull();
  expect(trigger.className).toContain("text-warning");
  expect(
    surfaceJson.mock.calls.some(([, init]) => init?.method === "PUT"),
  ).toBe(false);
});
