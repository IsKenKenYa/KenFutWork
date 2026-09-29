import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreditInsufficientDialog } from "../src/components/credits/credit-insufficient-dialog";

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "tok" } }),
}));

/**
 * 额度不足弹窗（2026-09-27）：整块曾是英文（Not Enough Credits / Required / Needed /
 * Claim Daily Credits / Upgrade Plan / Cancel），汉化后由本测试锁死中文文案与差额计算；
 * `ui-copy-localized` 门禁同时把英文原文放进禁列，防回归。
 */
describe("CreditInsufficientDialog（额度不足）", () => {
  afterEach(cleanup);

  it("中文文案 + 差额 = 需要 − 可用", () => {
    render(
      <CreditInsufficientDialog
        open
        currentBalance={3}
        requiredAmount={25}
        plan="free"
        dailyClaimed={false}
        onClaimDaily={async () => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("额度不足")).toBeInTheDocument();
    expect(screen.getByText("需要")).toBeInTheDocument();
    expect(screen.getByText("可用")).toBeInTheDocument();
    expect(screen.getByText("差额")).toBeInTheDocument();
    expect(screen.getByText("22")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "领取今日额度" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "升级套餐" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("当日已领过：不给领取入口（避免死按钮）", () => {
    render(
      <CreditInsufficientDialog
        open
        currentBalance={3}
        requiredAmount={25}
        plan="free"
        dailyClaimed
        onClaimDaily={async () => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: "领取今日额度" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "升级套餐" }),
    ).toBeInTheDocument();
  });
});
