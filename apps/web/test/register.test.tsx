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
  mockReplace,
  mockSignUp,
} = vi.hoisted(() => ({
  mockFetchViewer: vi.fn().mockResolvedValue({
    workspace: { id: "w1" },
    profile: { id: "u1" },
    membership: { workspaceId: "w1", userId: "u1", role: "owner" },
  }),
  mockGetSession: vi.fn(),
  mockOnAuthStateChange: vi.fn(),
  mockReplace: vi.fn(),
  mockSignUp: vi.fn().mockResolvedValue({
    access_token: "token_1",
    expiresAt: "2026-10-13T00:00:00.000Z",
    user: { displayName: null, email: "new@test.com", id: "user-1" },
  }),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchViewer: mockFetchViewer,
}));

vi.mock("../src/lib/session", () => ({
  // AuthProvider 也在渲染链上：替身需覆盖它用到的导出
  loadSession: vi.fn(async () => null),
  signOut: vi.fn(async () => {}),
  signUp: mockSignUp,
  subscribeSession: vi.fn(() => () => {}),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: mockReplace })),
}));

import RegisterPage from "../src/app/register/page";
import { AuthProvider } from "../src/lib/auth-context";

describe("Register page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockOnAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("注册成功后用签发的会话令牌引导工作台（自管认证不做邮件确认）", async () => {
    render(
      <AuthProvider>
        <RegisterPage />
      </AuthProvider>,
    );

    fireEvent.change(await screen.findByLabelText(/^邮箱$/), {
      target: { value: "new-user@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/^密码$/), {
      target: { value: "password-123" },
    });
    fireEvent.change(screen.getByLabelText(/确认密码/), {
      target: { value: "password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /创建账号/ }));

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledWith({
        email: "new-user@example.com",
        password: "password-123",
      });
    });
    await waitFor(() => {
      expect(mockFetchViewer).toHaveBeenCalledWith("token_1");
    });
  });

  it("bootstraps the viewer when sign-up returns an active session", async () => {
    mockSignUp.mockResolvedValueOnce({
      access_token: "fresh-token",
      expiresAt: "2026-10-13T00:00:00.000Z",
      user: { displayName: null, email: "new-user@example.com", id: "u1" },
    });

    render(
      <AuthProvider>
        <RegisterPage />
      </AuthProvider>,
    );

    fireEvent.change(await screen.findByLabelText(/^邮箱$/), {
      target: { value: "new-user@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/^密码$/), {
      target: { value: "password-123" },
    });
    fireEvent.change(screen.getByLabelText(/确认密码/), {
      target: { value: "password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /创建账号/ }));

    await waitFor(() => {
      expect(mockFetchViewer).toHaveBeenCalledWith("fresh-token");
      expect(mockReplace).toHaveBeenCalledWith("/workbench");
    });
  });
});
