import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();
const getWorkspaceState = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));

vi.mock("@zui/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: { getState: () => ({ getWorkspaceState }) },
}));

const { CheckpointTimeline } = await import(
  "../src/components/workbench/zcode/host/CheckpointTimeline.js"
);

const user = userEvent.setup();

const TIMELINE = {
  checkpoints: [
    {
      id: "cp-1",
      runId: "r1",
      createdAt: "2026-10-12T01:00:00.000Z",
      filesChanged: 1,
      insertions: 10,
      deletions: 2,
    },
    {
      id: "cp-2",
      runId: "r2",
      createdAt: "2026-10-12T02:00:00.000Z",
      filesChanged: 3,
      insertions: 30,
      deletions: 5,
    },
  ],
};

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
  getWorkspaceState.mockReset();
});

test("时间线倒序渲染、预览随目标切换、确认回滚 POST restore", async () => {
  getWorkspaceState.mockReturnValue({ activeTaskId: "task-1" });
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST" && path.includes("/preview")) {
      return {
        targetSha: "sha",
        filesChanged: 2,
        insertions: 8,
        deletions: 3,
        files: [{ path: "a.ts", additions: 5, deletions: 3 }],
      };
    }
    if (init?.method === "POST" && path.includes("/restore")) {
      return { checkpoint: TIMELINE.checkpoints[0] };
    }
    return TIMELINE;
  });
  const onRestored = vi.fn();
  render(<CheckpointTimeline workspacePath="/repo" onRestored={onRestored} />);
  // 列表非空才出现入口（最新在前默认选 cp-2）
  const trigger = await screen.findByTestId("checkpoint-timeline-trigger");
  await user.click(trigger);
  await waitFor(() =>
    expect(screen.getByText(/将覆盖 2 个文件的未提交改动/)).toBeTruthy(),
  );

  await user.click(screen.getByRole("button", { name: "回滚" }));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/code/checkpoints/cp-2/restore?taskId=task-1",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(onRestored).toHaveBeenCalled();
});

test("无 Task 或空时间线时入口不渲染（不摆空壳）", async () => {
  getWorkspaceState.mockReturnValue({ activeTaskId: null });
  const { rerender } = render(
    <CheckpointTimeline workspacePath="/repo" onRestored={() => {}} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(screen.queryByTestId("checkpoint-timeline-trigger")).toBeNull();

  getWorkspaceState.mockReturnValue({ activeTaskId: "task-2" });
  surfaceJson.mockImplementation(async () => ({ checkpoints: [] }));
  rerender(<CheckpointTimeline workspacePath="/repo" onRestored={() => {}} />);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(screen.queryByTestId("checkpoint-timeline-trigger")).toBeNull();
});
