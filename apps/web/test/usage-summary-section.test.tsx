// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UsageSummarySection } from "../src/components/usage-summary-section";
import { fetchUsageSummary } from "../src/lib/server-api";

const fetchUsageSummaryMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/server-api", () => ({
  fetchUsageSummary: fetchUsageSummaryMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("UsageSummarySection（DEC-6 用量摘要 UI）", () => {
  it("渲染 token 总量与分模型明细", async () => {
    fetchUsageSummaryMock.mockResolvedValue({
      totals: { inputTokens: 1234, outputTokens: 567, costUsd: 0.0123 },
      byModel: [
        {
          provider: "instance",
          model: "gpt-x",
          capability: "chat",
          inputTokens: 1000,
          outputTokens: 500,
          costUsd: 0.01,
        },
        {
          provider: "builtin",
          model: "flux-pro",
          capability: "image",
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
    });
    render(<UsageSummarySection accessToken="token" />);
    await waitFor(() => {
      expect(screen.getByText(/1,234 tokens/)).toBeDefined();
    });
    expect(screen.getByText("gpt-x")).toBeDefined();
    expect(screen.getByText("flux-pro")).toBeDefined();
  });

  it("空明细显示占位；加载失败显示错误", async () => {
    fetchUsageSummaryMock.mockResolvedValue({
      totals: { inputTokens: 0, outputTokens: 0 },
      byModel: [],
    });
    const { unmount } = render(<UsageSummarySection accessToken="token" />);
    expect(await screen.findByText("暂无用量记录")).toBeDefined();
    unmount();

    fetchUsageSummaryMock.mockRejectedValue(new Error("401"));
    render(<UsageSummarySection accessToken="token" />);
    expect(await screen.findByRole("alert")).toBeDefined();
  });
});
