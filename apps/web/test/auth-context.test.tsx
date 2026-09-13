// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadSession, mockSignOut, mockSubscribeSession } = vi.hoisted(
  () => ({
    mockLoadSession: vi.fn(),
    mockSignOut: vi.fn(),
    mockSubscribeSession: vi.fn(() => () => {}),
  }),
);

vi.mock("../src/lib/session", () => ({
  loadSession: mockLoadSession,
  signOut: mockSignOut,
  subscribeSession: mockSubscribeSession,
}));

import { AuthProvider, useAuth } from "../src/lib/auth-context";

function TestConsumer() {
  const { user, loading } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{user?.email ?? "none"}</span>
    </div>
  );
}

describe("AuthProvider", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSession.mockResolvedValue(null);
  });

  it("starts in loading state then resolves to no user", async () => {
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });
    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  it("exposes user when session exists", async () => {
    mockLoadSession.mockResolvedValue({
      access_token: "token_123",
      expiresAt: null,
      user: { id: "user_1", email: "test@test.com", displayName: null },
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("test@test.com");
    });
  });
});
