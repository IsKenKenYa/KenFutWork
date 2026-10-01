// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountSection } from "../src/components/workbench/account-section";
import { isLocalTrustSession } from "../src/lib/session";

/**
 * 本机主人（local-trust 免登录形态）的账号区语义（对齐 ZCode：BYOK 本地
 * 形态没有账号概念——「退出登录」无意义、登录邮箱是内部占位地址）。
 * 判定 helper 与 UserMenu 同源（isLocalTrustSession），这里同时锁死其语义。
 */

let sessionValue: { access_token: string } | null = null;

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    session: sessionValue,
    user: null,
    loading: false,
    signOut: vi.fn(),
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  sessionValue = null;
});

describe("isLocalTrustSession（会话形态判定）", () => {
  it("local-trust 占位标记 → true；真令牌/无会话 → false", () => {
    expect(isLocalTrustSession({ access_token: "local-trust", expiresAt: null, user: { displayName: null, email: "", id: "" } })).toBe(true);
    expect(
      isLocalTrustSession({ access_token: "real-token", expiresAt: null, user: { displayName: null, email: "", id: "" } }),
    ).toBe(false);
    expect(isLocalTrustSession(null)).toBe(false);
  });
});

describe("AccountSection：本机主人（local-trust）", () => {
  it("免登录形态：邮箱行显示「本机用户（免登录）」，不暴露内部占位地址", () => {
    sessionValue = { access_token: "local-trust" };
    render(
      <AccountSection
        displayName="本机用户"
        email="local@kenfutwork.local"
        plan={null}
        balance={null}
        isAdmin={false}
      />,
    );
    expect(screen.getByText("本机用户（免登录）")).toBeInTheDocument();
    expect(screen.queryByText("local@kenfutwork.local")).not.toBeInTheDocument();
  });

  it("口令形态：邮箱如实显示，行为不变", () => {
    sessionValue = { access_token: "real-token" };
    render(
      <AccountSection
        displayName="张三"
        email="zhang@example.com"
        plan={null}
        balance={null}
        isAdmin={false}
      />,
    );
    expect(screen.getByText("zhang@example.com")).toBeInTheDocument();
  });
});
