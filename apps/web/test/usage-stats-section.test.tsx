// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UsageStatsSection } from "../src/components/workbench/usage-stats-section";

const { useAuthMock } = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: useAuthMock,
}));

const STATS_7D = {
  rangeDays: 7,
  totals: { tokens: 1960, inputTokens: 1350, outputTokens: 610 },
  peakDayTokens: 1560,
  currentStreakDays: 3,
  longestStreakDays: 4,
  longestSessionSeconds: 42_300,
  // 热力图是近一年逐日（组件按周分列渲染）
  heatmap: [
    { date: "2026-09-15", tokens: 400 },
    { date: "2026-09-14", tokens: 0 },
  ],
  daily: [
    { date: "2026-09-09", tokens: 0 },
    { date: "2026-09-10", tokens: 0 },
    { date: "2026-09-11", tokens: 0 },
    { date: "2026-09-12", tokens: 0 },
    { date: "2026-09-13", tokens: 1560 },
    { date: "2026-09-14", tokens: 0 },
    { date: "2026-09-15", tokens: 400 },
  ],
  byModel: [
    { provider: "openai", model: "gpt-4.1", tokens: 1560 },
    { provider: "google", model: "gemini", tokens: 400 },
  ],
  // 逐日 × 模型（趋势图按模型画多条线；与 daily 按下标对齐）
  dailyByModel: [
    { model: "gpt-4.1", tokens: [0, 0, 0, 0, 1560, 0, 0] },
    { model: "gemini", tokens: [0, 0, 0, 0, 0, 0, 400] },
  ],
};

function mockFetchWith(stats: unknown, ok = true) {
  return vi.fn(async (_input: RequestInfo | URL) =>
    ok
      ? new Response(JSON.stringify(stats), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({}), { status: 500 }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthMock.mockReturnValue({ session: { access_token: "token" } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UsageStatsSection（R4-2 用户侧使用统计）", () => {
  it("加载并渲染汇总卡（累计/峰值/连续天数）", async () => {
    vi.stubGlobal("fetch", mockFetchWith(STATS_7D));
    render(<UsageStatsSection />);

    await waitFor(() => {
      expect(screen.getAllByText("1960")[0]).toBeInTheDocument();
    });
    // 1560 同时出现在汇总条与环图图例（同一数据两个视图）
    expect(screen.getAllByText("1560").length).toBeGreaterThan(0);
    expect(screen.getByText("3 天")).toBeInTheDocument();
    expect(screen.getByText("4 天")).toBeInTheDocument();
    // 最长聊天时长（R4-2 剩下的那张卡）：42300 秒 = 11 小时 45 分钟
    expect(screen.getByText("11 小时 45 分钟")).toBeInTheDocument();
  });

  it("请求带 days=7 且默认展示近 7 日", async () => {
    const fetchMock = mockFetchWith(STATS_7D);
    vi.stubGlobal("fetch", fetchMock);
    render(<UsageStatsSection />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("days=7");
    expect(screen.getByText("近 7 日")).toBeInTheDocument();
  });

  it("切换近 30 日重新请求 days=30", async () => {
    const fetchMock = mockFetchWith(STATS_7D);
    vi.stubGlobal("fetch", fetchMock);
    render(<UsageStatsSection />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("近 30 日"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("days=30");
  });

  it("环图图例带模型名与份额（gpt-4.1 80% / gemini 20%）", async () => {
    vi.stubGlobal("fetch", mockFetchWith(STATS_7D));
    render(<UsageStatsSection />);

    const legend = await screen.findByRole("list", {
      name: "模型用量图例",
    });
    const text = legend.textContent ?? "";
    expect(text).toContain("gpt-4.1");
    expect(text).toContain("80%");
    expect(text).toContain("gemini");
    expect(text).toContain("20%");
  });

  it("接口失败时显示可读错误而不是空白", async () => {
    vi.stubGlobal("fetch", mockFetchWith({}, false));
    render(<UsageStatsSection />);

    await waitFor(() => {
      expect(screen.getByText(/统计加载失败/)).toBeInTheDocument();
    });
  });

  it("趋势图按模型出图例（参考图：彩色圆点 + 模型名，按用量降序）", async () => {
    vi.stubGlobal("fetch", mockFetchWith(STATS_7D));
    render(<UsageStatsSection />);

    const legend = await screen.findByRole("list", { name: "模型图例" });
    const items = Array.from(legend.querySelectorAll("li")).map(
      (item) => item.textContent ?? "",
    );
    expect(items[0]).toContain("gpt-4.1");
    expect(items[1]).toContain("gemini");
  });

  it("热力图不出横向滚动条：格子随容器伸缩，月份标签在网格下方（参考图同款）", async () => {
    vi.stubGlobal("fetch", mockFetchWith(STATS_7D));
    const { container } = render(<UsageStatsSection />);

    await screen.findByText("Token 活动");
    // 没有 overflow-x 容器（此前固定格宽 + overflow-x-auto 必出滚动条）
    expect(container.querySelector(".overflow-x-auto")).toBeNull();
  });

  it("Token 活动支持 每日/累计 切换（累计视图文案随之变化）", async () => {
    vi.stubGlobal("fetch", mockFetchWith(STATS_7D));
    render(<UsageStatsSection />);

    expect(await screen.findByText(/近一年 · 每日/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "累计" }));
    expect(screen.getByText(/近一年 · 累计/)).toBeInTheDocument();
  });
});
