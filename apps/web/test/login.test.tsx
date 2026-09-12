// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchViewer,
  mockGetSession,
  mockOnAuthStateChange,
  mockSignInWithOtp,
  mockSignInWithPassword,
  mockSignInWithOAuth,
  mockReplace,
  mockSearchParams,
} = vi.hoisted(() => ({
  mockFetchViewer: vi.fn().mockResolvedValue({
    workspace: { id: "w1" },
    profile: { id: "u1" },
    membership: { workspaceId: "w1", userId: "u1", role: "owner" },
  }),
  mockGetSession: vi.fn(),
  mockOnAuthStateChange: vi.fn(),
  mockSignInWithOtp: vi.fn().mockResolvedValue({ error: null }),
  mockSignInWithPassword: vi.fn().mockResolvedValue({
    data: {
      session: {
        access_token: "session-token",
        user: { id: "u1", email: "user@example.com" },
      },
    },
    error: null,
  }),
  mockSignInWithOAuth: vi.fn().mockResolvedValue({ error: null }),
  mockReplace: vi.fn(),
  mockSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchViewer: mockFetchViewer,
}));

vi.mock("../src/lib/supabase-browser", () => ({
  getSupabaseBrowserClient: vi.fn(() => ({
    auth: {
      signInWithOtp: mockSignInWithOtp,
      signInWithPassword: mockSignInWithPassword,
      signInWithOAuth: mockSignInWithOAuth,
      onAuthStateChange: mockOnAuthStateChange,
      getSession: mockGetSession,
    },
  })),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: mockReplace })),
  useSearchParams: mockSearchParams,
}));

import LoginPage from "../src/app/login/page";
import { AuthProvider } from "../src/lib/auth-context";

describe("Login page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockOnAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    mockSearchParams.mockReturnValue(new URLSearchParams());
  });

  afterEach(() => {
    cleanup();
  });

  it("renders centered workbench-style card with password login only", async () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );
    expect((await screen.findByText("KenFutWork")).textContent).toBe(
      "KenFutWork",
    );
    // 只暴露账密登录：密码输入框与登录按钮存在，无魔法链接/Google 入口
    expect(screen.getByLabelText(/密码/)).toBeDefined();
    expect(screen.getByRole("button", { name: "登录" })).toBeDefined();
    expect(screen.queryByText(/发送登录链接/)).toBeNull();
    expect(screen.queryByText(/Google/)).toBeNull();
    expect(
      screen.getByRole("link", { name: /注册一个/ }).getAttribute("href"),
    ).toBe("/register");
  });

  it("shows callback errors from the query string as a banner", async () => {
    mockSearchParams.mockReturnValue(
      new URLSearchParams("error=auth_exchange_failed"),
    );

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "登录链接校验失败，请重新发起登录。",
    );
  });

  it("bootstraps the viewer before redirecting after password sign-in", async () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    fireEvent.change(await screen.findByLabelText(/邮箱/), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/密码/), {
      target: { value: "password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "password-123",
      });
      expect(mockFetchViewer).toHaveBeenCalledWith("session-token");
      expect(mockReplace).toHaveBeenCalledWith("/workbench");
    });
  });
});
