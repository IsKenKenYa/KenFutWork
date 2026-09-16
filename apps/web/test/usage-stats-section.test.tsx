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
      expect(screen.getByText("1960")).toBeInTheDocument();
    });
    expect(screen.getByText("1560")).toBeInTheDocument();
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

    await waitFor(() => {
      expect(screen.getByText("gpt-4.1")).toBeInTheDocument();
    });
    expect(screen.getByText(/80%/)).toBeInTheDocument();
    expect(screen.getByText("gemini")).toBeInTheDocument();
    expect(screen.getByText(/20%/)).toBeInTheDocument();
  });

  it("接口失败时显示可读错误而不是空白", async () => {
    vi.stubGlobal("fetch", mockFetchWith({}, false));
    render(<UsageStatsSection />);

    await waitFor(() => {
      expect(screen.getByText(/统计加载失败/)).toBeInTheDocument();
    });
  });
});
