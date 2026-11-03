import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { RunTimelineResponse } from "@kenfutwork/shared";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
  getSurfaceApiBase: () => "http://localhost:3001",
}));

const { RunTimelineDialog } = await import(
  "../src/components/workbench/zcode/host/RunTimelineDialog.js"
);

const user = userEvent.setup();

const PAYLOAD: RunTimelineResponse = {
  run: {
    runId: "r1",
    model: "glm-5.3-flash",
    status: "completed",
    stopReason: null,
    errorCode: null,
    errorMessage: null,
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

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
  vi.restoreAllMocks();
});

test("读取一轮运行：状态、用量、耗时与条目按时间线展示", async () => {
  surfaceJson.mockResolvedValue(PAYLOAD);
  render(<RunTimelineDialog runId="r1" open onOpenChange={() => {}} />);

  await waitFor(() =>
    expect(
      surfaceJson,
    ).toHaveBeenCalledWith("/api/agent/runs/r1/timeline", undefined),
  );
  expect(screen.getByText(/状态 已完成/)).toBeTruthy();
  expect(screen.getByText(/模型 glm-5\.3-flash/)).toBeTruthy();
  expect(screen.getByText(/耗时 5\.0s/)).toBeTruthy();
  expect(screen.getByText(/输入 1200 输出 340/)).toBeTruthy();
  expect(screen.getByText(/花费 \$0\.0123/)).toBeTruthy();
  expect(screen.getByText(/Read 读取文件/)).toBeTruthy();
  expect(screen.getByText(/上下文压缩/)).toBeTruthy();
});

test("失败原文可读，用量缺省显示未统计，重新读取成功后可回看", async () => {
  surfaceJson
    .mockRejectedValueOnce(new Error("运行不存在"))
    .mockResolvedValueOnce({
      ...PAYLOAD,
      run: {
        ...PAYLOAD.run,
        status: "failed",
        errorMessage: "模型返回格式错误",
        usage: null,
      },
      entries: [],
    });
  render(<RunTimelineDialog runId="r1" open onOpenChange={() => {}} />);

  await waitFor(() =>
    expect(screen.getByText("运行不存在")).toBeTruthy(),
  );
  await user.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() =>
    expect(screen.getByText(/状态 失败/)).toBeTruthy(),
  );
  expect(screen.getByText("模型返回格式错误")).toBeTruthy();
  expect(screen.getByText(/用量 未统计/)).toBeTruthy();
  expect(screen.getByText("这一轮没有记录")).toBeTruthy();
});

test("导出记录打开服务端 Markdown 下载地址", async () => {
  surfaceJson.mockResolvedValue(PAYLOAD);
  const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
  render(<RunTimelineDialog runId="r1" open onOpenChange={() => {}} />);

  await user.click(screen.getByRole("button", { name: "导出记录" }));
  expect(openSpy).toHaveBeenCalledWith(
    "http://localhost:3001/api/agent/runs/r1/timeline/export",
    "_blank",
    "noopener",
  );
});
