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
  mockSignInWithPassword,
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
  mockSignInWithPassword: vi.fn().mockResolvedValue({
    access_token: "session-token",
    expiresAt: "2026-10-13T00:00:00.000Z",
    user: { displayName: null, email: "user@example.com", id: "u1" },
  }),
  mockReplace: vi.fn(),
  mockSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchViewer: mockFetchViewer,
}));

vi.mock("../src/lib/session", () => ({
  // AuthProvider 也在渲染链上：替身需覆盖它用到的导出
  loadSession: mockGetSession,
  signInWithPassword: mockSignInWithPassword,
  signOut: vi.fn(async () => {}),
  subscribeSession: mockOnAuthStateChange,
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
    mockGetSession.mockResolvedValue(null);
    mockOnAuthStateChange.mockReturnValue(() => {});
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
