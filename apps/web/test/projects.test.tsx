// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../src/components/toast";

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockRouter = { push: mockPush, replace: mockReplace };
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => mockRouter),
}));

const mockSignOut = vi.fn();
const mockUser = { id: "u1", email: "test@test.com" };
const mockSession = { access_token: "token_123" };
const mockAuthValue = {
  user: mockUser,
  session: mockSession,
  loading: false,
  signOut: mockSignOut,
};
vi.mock("../src/lib/auth-context", () => ({
  useAuth: vi.fn(() => mockAuthValue),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

import ProjectsPage from "../src/app/(workspace)/projects/page";

const viewerResponse = {
  profile: {
    id: "u1",
    email: "test@test.com",
    displayName: "Test",
    avatarUrl: null,
  },
  workspace: {
    id: "w1",
    name: "My Workspace",
    type: "personal",
    ownerUserId: "u1",
  },
  membership: { workspaceId: "w1", userId: "u1", role: "owner" },
};

const workspace = {
  id: "w1",
  name: "My Workspace",
  type: "personal",
  ownerUserId: "u1",
};

const createdProjectResponse = {
  project: {
    id: "p-new",
    name: "Untitled",
    slug: "untitled",
    description: null,
    workspace,
    primaryCanvas: { id: "c-created", name: "Main Canvas", isPrimary: true },
    createdAt: "2026-03-24T00:00:00Z",
    updatedAt: "2026-03-24T00:00:00Z",
  },
};

const projectsResponse = {
  projects: [
    {
      id: "p1",
      name: "Brand System",
      slug: "brand-system",
      description: "Primary brand project",
      workspace,
      primaryCanvas: { id: "c1", name: "Main Canvas", isPrimary: true },
      createdAt: "2026-03-23T00:00:00Z",
      updatedAt: "2026-03-23T10:00:00Z",
    },
    {
      id: "p2",
      name: "App Redesign",
      slug: "app-redesign",
      description: null,
      workspace,
      primaryCanvas: { id: "c2", name: "Main Canvas", isPrimary: true },
      createdAt: "2026-03-22T00:00:00Z",
      updatedAt: "2026-03-22T00:00:00Z",
    },
  ],
};

/**
 * URL-based mock that always returns success for viewer/projects.
 * Handles React 19 double-effect invocation in tests.
 */
function mockSuccessfulLoad(projectsOverride?: unknown) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/api/viewer")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => viewerResponse,
      });
    }
    if (url.includes("/api/projects")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => projectsOverride ?? projectsResponse,
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
}

describe("Projects page", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  it("renders the projects heading with project cards", async () => {
    mockSuccessfulLoad();
    render(
      <ToastProvider>
        <ProjectsPage />
      </ToastProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "项目" }),
    ).toBeInTheDocument();
    // Project names appear in the project card grid
    const brandItems = await screen.findAllByText("Brand System");
    expect(brandItems.length).toBeGreaterThanOrEqual(1);
    const redesignItems = await screen.findAllByText("App Redesign");
    expect(redesignItems.length).toBeGreaterThanOrEqual(1);
  });

  it("shows only the create card when no projects", async () => {
    mockSuccessfulLoad({ projects: [] });
    render(
      <ToastProvider>
        <ProjectsPage />
      </ToastProvider>,
    );

    expect(
      await screen.findByRole("button", { name: "新建项目" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Brand System")).not.toBeInTheDocument();
  });

  it("creates an Untitled project and navigates to its canvas on 新建项目 click", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/api/projects") && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => createdProjectResponse,
        });
      }
      if (url.includes("/api/viewer")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => viewerResponse,
        });
      }
      if (url.includes("/api/projects")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => projectsResponse,
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
      });
    });
    render(
      <ToastProvider>
        <ProjectsPage />
      </ToastProvider>,
    );

    const createCard = await screen.findByRole("button", { name: "新建项目" });
    await userEvent.click(createCard);

    // jsdom window.open returns null → hook falls back to in-page navigation
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/canvas?id=c-created");
    });
  });

  it("calls signOut and redirects on 401 from fetchViewer", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/viewer")) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({
            error: { code: "unauthorized", message: "Bad token" },
          }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
      });
    });

    render(
      <ToastProvider>
        <ProjectsPage />
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
  });

  it("shows error banner with retry on 500 from fetchViewer — does NOT redirect", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/viewer")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({
            error: { code: "bootstrap_failed", message: "Server error" },
          }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
      });
    });

    render(
      <ToastProvider>
        <ProjectsPage />
      </ToastProvider>,
    );
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("calls signOut and redirects on 401 from fetchProjects", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/viewer")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => viewerResponse,
        });
      }
      if (url.includes("/api/projects")) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({
            error: { code: "unauthorized", message: "Bad token" },
          }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
      });
    });

    render(
      <ToastProvider>
        <ProjectsPage />
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
  });

  it("shows a toast error on 409 project_slug_taken during create", async () => {
    mockSuccessfulLoad();
    // Override fetch for the create call
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/api/projects") && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            error: { code: "project_slug_taken", message: "Slug taken." },
          }),
        });
      }
      // Keep returning success for any background refetch
      if (url.includes("/api/viewer")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => viewerResponse,
        });
      }
      if (url.includes("/api/projects")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => projectsResponse,
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
      });
    });
    render(
      <ToastProvider>
        <ProjectsPage />
      </ToastProvider>,
    );

    const createCard = await screen.findByRole("button", { name: "新建项目" });
    await userEvent.click(createCard);

    expect(await screen.findByText("项目创建失败")).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalledWith("/login");
  });

  it("shows a toast error on 500 project_create_failed during create", async () => {
    mockSuccessfulLoad();
    // Override fetch for the create call
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/api/projects") && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({
            error: { code: "project_create_failed", message: "Create failed." },
          }),
        });
      }
      if (url.includes("/api/viewer")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => viewerResponse,
        });
      }
      if (url.includes("/api/projects")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => projectsResponse,
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
      });
    });
    render(
      <ToastProvider>
        <ProjectsPage />
      </ToastProvider>,
    );

    const createCard = await screen.findByRole("button", { name: "新建项目" });
    await userEvent.click(createCard);

    expect(await screen.findByText("项目创建失败")).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalledWith("/login");
  });
});
