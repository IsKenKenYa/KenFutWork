import type { RunTimelineResponse, TaskRunsResponse } from "@kenfutwork/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
  getSurfaceApiBase: () => "http://localhost:3001",
}));

const { RunTimelineDialog } = await import(
  "../src/components/workbench/zcode/host/RunTimelineDialog.js"
);

const user = userEvent.setup();

const RUNS: TaskRunsResponse = {
  taskId: "task-1",
  runs: [
    {
      runId: "r2",
      model: "glm-5.3-flash",
      status: "failed",
      stopReason: null,
      errorCode: "model_error",
      errorMessage: "模型返回格式错误",
      startedAt: "2026-11-04T10:00:00.000Z",
      completedAt: "2026-11-04T10:00:05.000Z",
      usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.0123 },
    },
    {
      runId: "r1",
      model: null,
      status: "completed",
      stopReason: "completed",
      errorCode: null,
      errorMessage: null,
      startedAt: "2026-11-04T09:00:00.000Z",
      completedAt: "2026-11-04T09:00:02.000Z",
      usage: null,
    },
  ],
};

const PAYLOAD: RunTimelineResponse = {
  run: {
    runId: "r2",
    model: "glm-5.3-flash",
    status: "failed",
    stopReason: null,
    errorCode: "model_error",
    errorMessage: "模型返回格式错误",
    startedAt: "2026-11-04T10:00:00.000Z",
    completedAt: "2026-11-04T10:00:05.000Z",
    usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.0123 },
  },
  entries: [
    {
      kind: "tool",
      seq: 1,
      at: "2026-11-04T10:00:01.000Z",
      title: "Read 读取文件",
      status: "success",
      durationMs: 800,
      detail: "已读取 42 行",
    },
    {
      kind: "compaction",
      seq: 2,
      at: "2026-11-04T10:00:03.000Z",
      title: "上下文压缩",
    },
  ],
};

function routeApi(handlers: {
  runs?: () => TaskRunsResponse | Promise<TaskRunsResponse>;
  timeline?: (
    path: string,
  ) => RunTimelineResponse | Promise<RunTimelineResponse>;
}) {
  surfaceJson.mockImplementation(async (path: string) => {
    if (path.includes("/timeline")) {
      return handlers.timeline ? handlers.timeline(path) : PAYLOAD;
    }
    if (path.startsWith("/api/agent/tasks/")) {
      return handlers.runs ? handlers.runs() : RUNS;
    }
    return handlers.timeline ? handlers.timeline(path) : PAYLOAD;
  });
}

function renderDialog(overrides?: {
  projectId?: string | null;
  initialRunId?: string | null;
}) {
  return render(
    <RunTimelineDialog
      taskId="task-1"
      projectId={
        overrides && "projectId" in overrides
          ? overrides.projectId
          : "project-1"
      }
      initialRunId={overrides?.initialRunId ?? null}
      open
      onOpenChange={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
  vi.restoreAllMocks();
});

test("先列轮次：状态、模型、耗时、用量与失败原因", async () => {
  routeApi({});
  renderDialog();

  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/agent/tasks/task-1/runs?projectId=project-1&limit=20",
      undefined,
    ),
  );
  expect(screen.getByText("失败")).toBeTruthy();
  expect(screen.getByText("已完成")).toBeTruthy();
  expect(screen.getByText("glm-5.3-flash")).toBeTruthy();
  expect(screen.getByText("模型 未记录")).toBeTruthy();
  expect(screen.getByText("耗时 5.0s")).toBeTruthy();
  expect(screen.getByText("输入 1200 输出 340")).toBeTruthy();
  expect(screen.getByText("花费 $0.0123")).toBeTruthy();
  expect(screen.getByText("用量 未统计")).toBeTruthy();
  expect(screen.getByText("模型返回格式错误")).toBeTruthy();
});

test("点选轮次进入单轮时间线，返回后仍在轮次列表", async () => {
  routeApi({});
  renderDialog();

  await user.click(await screen.findByTestId("run-row-r2"));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/agent/tasks/task-1/runs/r2/timeline?projectId=project-1",
      undefined,
    ),
  );
  expect(screen.getByText(/Read 读取文件/)).toBeTruthy();
  expect(screen.getByText(/上下文压缩/)).toBeTruthy();
  expect(screen.getByText(/状态 失败/)).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "轮次列表" }));
  await waitFor(() => expect(screen.getByText("已完成")).toBeTruthy());
});

test("空列表与缺少项目信息都给出可读说明", async () => {
  routeApi({ runs: () => ({ taskId: "task-1", runs: [] }) });
  renderDialog();

  await waitFor(() =>
    expect(screen.getByText("这个 Task 还没有运行记录")).toBeTruthy(),
  );

  cleanup();
  surfaceJson.mockReset();
  renderDialog({ projectId: null });
  expect(screen.getByText("缺少项目信息")).toBeTruthy();
  expect(surfaceJson).not.toHaveBeenCalled();
});

test("轮次读取失败后重新读取", async () => {
  surfaceJson
    .mockRejectedValueOnce(new Error("项目不存在"))
    .mockResolvedValueOnce(RUNS);
  renderDialog();

  await waitFor(() => expect(screen.getByText("项目不存在")).toBeTruthy());
  await user.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() => expect(screen.getByText("已完成")).toBeTruthy());
});

test("查看更多每次多取 20 轮，到 50 轮说明只看最近", async () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...RUNS.runs[1]!,
      runId: `r${index + 1}`,
    }));
  const seen: string[] = [];
  routeApi({
    runs: () => {
      seen.push(surfaceJson.mock.calls.at(-1)?.[0] ?? "");
      const limit = Number(
        new URL(`http://localhost${seen.at(-1) ?? ""}`).searchParams.get(
          "limit",
        ),
      );
      return { taskId: "task-1", runs: rows(limit) };
    },
  });
  renderDialog();

  await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(20));
  await user.click(screen.getByRole("button", { name: "查看更多" }));
  await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(40));
  await user.click(screen.getByRole("button", { name: "查看更多" }));
  await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(50));
  expect(screen.getByText("只显示最近 50 轮")).toBeTruthy();
  expect(seen.at(-1)).toContain("limit=50");
});

test("检查点对应轮次标出但不抢占列表", async () => {
  routeApi({});
  renderDialog({ initialRunId: "r2" });

  await waitFor(() =>
    expect(screen.getAllByText("当前检查点")).toHaveLength(1),
  );
  expect(screen.getByText("已完成")).toBeTruthy();
});

test("导出记录打开服务端 Markdown 下载地址", async () => {
  routeApi({});
  const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
  renderDialog();

  await user.click(await screen.findByTestId("run-row-r2"));
  await user.click(await screen.findByRole("button", { name: "导出记录" }));
  expect(openSpy).toHaveBeenCalledWith(
    "http://localhost:3001/api/agent/tasks/task-1/runs/r2/timeline/export?projectId=project-1",
    "_blank",
    "noopener",
  );
});
