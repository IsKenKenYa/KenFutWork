import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));

const { CheckpointTimeline } = await import(
  "../src/components/workbench/zcode/host/CheckpointTimeline.js"
);
const { useZCodeSessionStore } = await import(
  "@zui/store/zcodeSessionStore.js"
);

const user = userEvent.setup();
const projectId = "123e4567-e89b-42d3-a456-426614174000";
const workspaceIdentity = JSON.stringify([projectId, "/repo"]);
const shadowCommit = "a".repeat(40);
const expectedVersion = "checkpoint-preview-version";
const summary = {
  projectId,
  taskId: "task-1",
  kind: "turn",
  label: "检查点",
  shadowCommit,
};

const TIMELINE = {
  checkpoints: [
    {
      ...summary,
      id: "cp-1",
      runId: "r1",
      createdAt: "2026-10-12T01:00:00.000Z",
      filesChanged: 1,
      insertions: 10,
      deletions: 2,
    },
    {
      ...summary,
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
  useZCodeSessionStore.getState().setActiveTaskId("/repo", null);
  useZCodeSessionStore
    .getState()
    .setActiveTaskId("/repo", null, workspaceIdentity);
});

test("时间线倒序渲染、预览随目标切换、确认回滚 POST restore", async () => {
  useZCodeSessionStore.getState().setActiveTaskId("/repo", "task-1");
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST" && path.includes("/preview")) {
      return {
        expectedVersion,
        targetSha: shadowCommit,
        filesChanged: 2,
        insertions: 8,
        deletions: 3,
        files: [{ rootDirectory: "/repo", path: "a.ts", added: 5, deleted: 3 }],
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
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedVersion }),
      }),
    ),
  );
  expect(onRestored).toHaveBeenCalled();
});

test("无 Task 或空时间线时入口不渲染（不摆空壳）", async () => {
  useZCodeSessionStore.getState().setActiveTaskId("/repo", null);
  const { rerender } = render(
    <CheckpointTimeline workspacePath="/repo" onRestored={() => {}} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(screen.queryByTestId("checkpoint-timeline-trigger")).toBeNull();

  useZCodeSessionStore.getState().setActiveTaskId("/repo", "task-2");
  surfaceJson.mockImplementation(async () => ({ checkpoints: [] }));
  rerender(<CheckpointTimeline workspacePath="/repo" onRestored={() => {}} />);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(screen.queryByTestId("checkpoint-timeline-trigger")).toBeNull();
});

test("检查点对话框可打开所选轮次的运行记录", async () => {
  useZCodeSessionStore
    .getState()
    .setActiveTaskId("/repo", "task-1", workspaceIdentity);
  surfaceJson.mockImplementation(async (path: string) => {
    if (path.includes("/runs?")) {
      return {
        taskId: "task-1",
        runs: [
          {
            runId: "r2",
            model: "glm-5.3-flash",
            status: "running",
            stopReason: null,
            errorCode: null,
            errorMessage: null,
            startedAt: "2026-10-12T02:00:00.000Z",
            completedAt: null,
            usage: null,
          },
        ],
      };
    }
    if (path.includes("/timeline")) {
      return {
        run: {
          runId: "r2",
          model: "glm-5.3-flash",
          status: "running",
          stopReason: null,
          errorCode: null,
          errorMessage: null,
          startedAt: "2026-10-12T02:00:00.000Z",
          completedAt: null,
          usage: null,
        },
        entries: [
          {
            kind: "tool",
            seq: 3,
            at: "2026-10-12T02:00:01.000Z",
            title: "Bash 运行测试",
            status: "running",
          },
        ],
      };
    }
    if (path.includes("/preview")) {
      return {
        expectedVersion,
        targetSha: shadowCommit,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        files: [],
      };
    }
    return TIMELINE;
  });
  render(
    <CheckpointTimeline
      workspacePath="/repo"
      workspaceIdentity={workspaceIdentity}
    />,
  );
  await user.click(await screen.findByTestId("checkpoint-timeline-trigger"));
  await user.click(screen.getByRole("button", { name: "这一轮运行" }));
  // 先列轮次，再点选检查点对应的那一轮进入时间线。
  await waitFor(() => expect(screen.getByText("当前检查点")).toBeTruthy());
  await user.click(screen.getByTestId("run-row-r2"));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/agent/tasks/task-1/runs/r2/timeline?projectId=123e4567-e89b-42d3-a456-426614174000",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  expect(screen.getByText(/状态 进行中/)).toBeTruthy();
  expect(screen.getByText(/Bash 运行测试/)).toBeTruthy();
});
