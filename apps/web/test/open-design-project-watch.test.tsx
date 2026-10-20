import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const projectRef = {
  current: null as { projectId: string; name?: string } | null,
};

vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: async () => ({ project: projectRef.current }),
}));

const { useOpenDesignProjectWatch } = await import(
  "../src/components/workbench/zcode/host/useOpenDesignProjectWatch.js"
);

afterEach(() => {
  cleanup();
  projectRef.current = null;
  vi.useRealTimers();
});

test("启动时的旧项目只记录不抢焦点，新建项目才回调（带画布名）", async () => {
  vi.useFakeTimers();
  projectRef.current = { projectId: "p-1", name: "旧画布" };
  const created = vi.fn();
  const view = renderHook(() => useOpenDesignProjectWatch(true, created));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(created).not.toHaveBeenCalled();

  projectRef.current = { projectId: "p-2", name: "新画布" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000);
  });
  expect(created).toHaveBeenCalledTimes(1);
  expect(created).toHaveBeenCalledWith("p-2", "新画布");

  // 同一个项目不会反复触发。
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000);
  });
  expect(created).toHaveBeenCalledTimes(1);

  view.unmount();
});

test("未启用时不轮询", async () => {
  vi.useFakeTimers();
  const created = vi.fn();
  renderHook(() => useOpenDesignProjectWatch(false, created));
  projectRef.current = { projectId: "p-2", name: "新画布" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000);
  });
  expect(created).not.toHaveBeenCalled();
});