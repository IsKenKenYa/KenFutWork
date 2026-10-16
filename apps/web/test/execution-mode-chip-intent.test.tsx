import type { ExecutionMode } from "@kenfutwork/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();
vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));
const { ExecutionModeChip, useExecutionModeController } = await import(
  "../src/components/workbench/zcode/host/ExecutionModeChip.js"
);

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function ComposerProbe({
  sessionId,
  sent,
  onSwitchMode,
  initialPlanning = false,
  sentSubmissions,
}: {
  sessionId: string;
  sent: ExecutionMode[];
  onSwitchMode: (mode: string) => void;
  initialPlanning?: boolean;
  sentSubmissions?: Array<{
    executionMode: ExecutionMode;
    planEnabled: boolean;
  }>;
}) {
  const [planning, setPlanning] = useState(initialPlanning);
  const controller = useExecutionModeController({
    sessionId,
    planEnabled: planning,
    onSwitchMode: (next) => {
      if (next === "plan" || next === "plan-off") setPlanning(next === "plan");
      onSwitchMode(next);
    },
  });
  const mode = controller.mode;
  useEffect(() => {
    setPlanning(sessionId ? initialPlanning : false);
  }, [initialPlanning, sessionId]);
  return (
    <>
      <ExecutionModeChip controller={controller} disabled={false} />
      <button
        type="button"
        onClick={() => controller.switchCollaborationMode("plan-off")}
      >
        关闭规划
      </button>
      <button
        type="button"
        onClick={() => controller.switchCollaborationMode("plan")}
      >
        开启规划
      </button>
      <button
        type="button"
        onClick={() => {
          if (mode) {
            sent.push(mode);
            sentSubmissions?.push({
              executionMode: mode,
              planEnabled: planning,
            });
          }
        }}
      >
        发送
      </button>
    </>
  );
}

function pendingModeChange(initialMode: ExecutionMode = "agent") {
  const pending = deferred();
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/execution-modes")
      return {
        modes: [
          { id: "agent", label: "自主" },
          { id: "goal", label: "目标" },
          { id: "plan", label: "计划" },
        ],
      };
    if (init?.method === "PUT") return pending.promise;
    return { mode: initialMode };
  });
  return pending;
}

afterEach(() => {
  cleanup();
  const focusReset = document.createElement("button");
  document.body.append(focusReset);
  focusReset.focus();
  focusReset.blur();
  focusReset.remove();
  surfaceJson.mockReset();
});

test("目标已显示时发送即捕获目标，偏好写入失败只回滚后续输入", async () => {
  const user = userEvent.setup();
  const pending = pendingModeChange();
  const sent: ExecutionMode[] = [];
  render(<ComposerProbe sessionId="a" sent={sent} onSwitchMode={vi.fn()} />);
  await user.click(await screen.findByTestId("execution-mode-chip"));
  await user.click(await screen.findByRole("menuitemradio", { name: "目标" }));
  expect(screen.getByTestId("execution-mode-chip").textContent).toContain(
    "目标",
  );
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(sent).toEqual(["goal"]);
  await act(async () => pending.reject(new Error("preference write failed")));
  await waitFor(() =>
    expect(screen.getByTestId("execution-mode-chip").textContent).toContain(
      "自主",
    ),
  );
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(sent).toEqual(["goal", "agent"]);
});

test("Task切换后忽略旧Task迟到PUT，不改新Task策略或规划草稿", async () => {
  const user = userEvent.setup();
  const pending = pendingModeChange();
  const sent: ExecutionMode[] = [];
  const onSwitchMode = vi.fn();
  const { rerender } = render(
    <ComposerProbe sessionId="a" sent={sent} onSwitchMode={onSwitchMode} />,
  );
  await user.click(await screen.findByTestId("execution-mode-chip"));
  await user.click(await screen.findByRole("menuitemradio", { name: "计划" }));
  rerender(
    <ComposerProbe sessionId="b" sent={sent} onSwitchMode={onSwitchMode} />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("execution-mode-chip").textContent).toContain(
      "自主",
    ),
  );
  onSwitchMode.mockClear();
  await act(async () => pending.resolve({ mode: "plan" }));
  expect(onSwitchMode).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(sent).toEqual(["agent"]);
});

test("离开计划立即发送关闭规划，偏好失败回滚只影响后续输入", async () => {
  const user = userEvent.setup();
  const pending = pendingModeChange("plan");
  const sent: ExecutionMode[] = [];
  const sentSubmissions: Array<{
    executionMode: ExecutionMode;
    planEnabled: boolean;
  }> = [];
  const onSwitchMode = vi.fn();
  render(
    <ComposerProbe
      sessionId="a"
      sent={sent}
      initialPlanning
      sentSubmissions={sentSubmissions}
      onSwitchMode={onSwitchMode}
    />,
  );
  await user.click(await screen.findByTestId("execution-mode-chip"));
  await user.click(await screen.findByRole("menuitemradio", { name: "自主" }));
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect.soft(onSwitchMode.mock.calls).toEqual([["plan-off"]]);
  expect
    .soft(sentSubmissions)
    .toEqual([{ executionMode: "agent", planEnabled: false }]);

  await act(async () => pending.reject(new Error("preference write failed")));
  await waitFor(() =>
    expect(screen.getByTestId("execution-mode-chip").textContent).toContain(
      "计划",
    ),
  );
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect.soft(onSwitchMode.mock.calls).toEqual([["plan-off"], ["plan"]]);
  expect(sentSubmissions).toEqual([
    { executionMode: "agent", planEnabled: false },
    { executionMode: "plan", planEnabled: true },
  ]);
});

test("切换Task后旧计划PUT失败不回滚新Task的规划草稿", async () => {
  const user = userEvent.setup();
  const pending = pendingModeChange("plan");
  const sent: ExecutionMode[] = [];
  const sentSubmissions: Array<{
    executionMode: ExecutionMode;
    planEnabled: boolean;
  }> = [];
  const onSwitchMode = vi.fn();
  const { rerender } = render(
    <ComposerProbe
      sessionId="a"
      sent={sent}
      initialPlanning
      sentSubmissions={sentSubmissions}
      onSwitchMode={onSwitchMode}
    />,
  );
  await user.click(await screen.findByTestId("execution-mode-chip"));
  await user.click(await screen.findByRole("menuitemradio", { name: "自主" }));
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/execution-modes")
      return { modes: [{ id: "agent", label: "自主" }] };
    if (init?.method === "PUT") throw new Error("新Task不应写偏好");
    return { mode: "agent" };
  });
  rerender(
    <ComposerProbe
      sessionId="b"
      sent={sent}
      sentSubmissions={sentSubmissions}
      onSwitchMode={onSwitchMode}
    />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("execution-mode-chip").textContent).toContain(
      "自主",
    ),
  );
  onSwitchMode.mockClear();
  await act(async () => pending.reject(new Error("旧Task偏好写入失败")));
  expect(onSwitchMode).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(sentSubmissions).toEqual([
    { executionMode: "agent", planEnabled: false },
  ]);
});

test("独立规划已开启时选择计划失败，保留原规划状态与自主策略", async () => {
  const user = userEvent.setup();
  const pending = pendingModeChange();
  const sent: ExecutionMode[] = [];
  const sentSubmissions: Array<{
    executionMode: ExecutionMode;
    planEnabled: boolean;
  }> = [];
  render(
    <ComposerProbe
      sessionId="a"
      sent={sent}
      initialPlanning
      sentSubmissions={sentSubmissions}
      onSwitchMode={vi.fn()}
    />,
  );
  await user.click(await screen.findByTestId("execution-mode-chip"));
  await user.click(await screen.findByRole("menuitemradio", { name: "计划" }));
  await user.click(screen.getByRole("button", { name: "发送" }));
  await act(async () => pending.reject(new Error("preference write failed")));
  await waitFor(() =>
    expect(screen.getByTestId("execution-mode-chip").textContent).toContain(
      "自主",
    ),
  );
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(sentSubmissions).toEqual([
    { executionMode: "plan", planEnabled: true },
    { executionMode: "agent", planEnabled: true },
  ]);
});

test.each(["success", "failure"] as const)(
  "手动规划折返后旧计划PUT%s不覆盖新意图，偏好按点击顺序落盘",
  async (result) => {
    const user = userEvent.setup();
    const pending = pendingModeChange();
    const sent: ExecutionMode[] = [];
    const sentSubmissions: Array<{
      executionMode: ExecutionMode;
      planEnabled: boolean;
    }> = [];
    const writes: string[] = [];
    surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/execution-modes")
        return {
          modes: [
            { id: "agent", label: "自主" },
            { id: "plan", label: "计划" },
          ],
        };
      if (init?.method !== "PUT") return { mode: "agent" };
      const mode = JSON.parse(String(init.body)).mode;
      writes.push(mode);
      return mode === "plan" ? pending.promise : { mode };
    });
    render(
      <ComposerProbe
        sessionId="a"
        sent={sent}
        initialPlanning
        sentSubmissions={sentSubmissions}
        onSwitchMode={vi.fn()}
      />,
    );
    await user.click(await screen.findByTestId("execution-mode-chip"));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "计划" }),
    );
    await user.click(screen.getByRole("button", { name: "关闭规划" }));
    await user.click(screen.getByRole("button", { name: "开启规划" }));
    await user.click(screen.getByRole("button", { name: "关闭规划" }));
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(sentSubmissions).toEqual([
      { executionMode: "agent", planEnabled: false },
    ]);
    expect(writes).toEqual(["plan"]);
    await act(async () =>
      result === "success"
        ? pending.resolve({ mode: "plan" })
        : pending.reject(new Error("旧偏好失败")),
    );
    await waitFor(() => expect(writes).toEqual(["plan", "agent"]));
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(sentSubmissions).toEqual([
      { executionMode: "agent", planEnabled: false },
      { executionMode: "agent", planEnabled: false },
    ]);
    expect(screen.getByTestId("execution-mode-chip").textContent).toContain(
      "自主",
    );
  },
);

test("策略未加载时明确关闭规划，迟到plan读取不重开且本次发送携带自主", async () => {
  const user = userEvent.setup();
  const loading = deferred();
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/execution-modes")
      return {
        modes: [
          { id: "agent", label: "自主" },
          { id: "plan", label: "计划" },
        ],
      };
    if (init?.method === "PUT") return { mode: "agent" };
    return loading.promise;
  });
  const sent: ExecutionMode[] = [];
  const sentSubmissions: Array<{
    executionMode: ExecutionMode;
    planEnabled: boolean;
  }> = [];
  render(
    <ComposerProbe
      sessionId="a"
      sent={sent}
      initialPlanning
      sentSubmissions={sentSubmissions}
      onSwitchMode={vi.fn()}
    />,
  );
  expect(screen.queryByTestId("execution-mode-chip")).toBeNull();
  await user.click(screen.getByRole("button", { name: "关闭规划" }));
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(sentSubmissions).toEqual([
    { executionMode: "agent", planEnabled: false },
  ]);
  await act(async () => loading.resolve({ mode: "plan" }));
  expect(
    (await screen.findByTestId("execution-mode-chip")).textContent,
  ).toContain("自主");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(sentSubmissions).toEqual([
    { executionMode: "agent", planEnabled: false },
    { executionMode: "agent", planEnabled: false },
  ]);
});
