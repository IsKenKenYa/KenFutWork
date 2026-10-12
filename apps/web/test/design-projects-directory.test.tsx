import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesignProjects } from "@/components/workbench/canvas-workbench/use-design-projects";

const api = vi.hoisted(() => ({
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  fetchDirectoryPickerStatus: vi.fn(),
  fetchProjectDirectoryRelinkSnapshot: vi.fn(),
  fetchProjects: vi.fn(),
  pickDirectory: vi.fn(),
  relinkProjectDirectory: vi.fn(),
  updateProject: vi.fn(),
}));
const desktop = vi.hoisted(() => ({ revealPath: vi.fn() }));

vi.mock("@/lib/server-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-api")>();
  return { ...actual, ...api };
});
vi.mock("@/lib/desktop-system", () => desktop);

function project(
  workDir: string | null = null,
  kind: "design" | "flow" = "design",
) {
  return {
    id: "project-1",
    name: "项目",
    slug: "project",
    kind,
    description: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    instanceId: "instance-1",
    workDir,
    additionalDirectories: [],
    primaryCanvas: {
      id: "canvas-1",
      name: "Main Canvas",
      isPrimary: true,
    },
  };
}

function renderProjectsHook() {
  return renderHook(() =>
    useDesignProjects("access-token", "design", { current: null }),
  );
}

function renderFlowProjectsHook() {
  return renderHook(() =>
    useDesignProjects("access-token", "flow", { current: null }),
  );
}

describe("Design project directory creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchProjects.mockReturnValue(new Promise(() => {}));
    api.fetchDirectoryPickerStatus.mockResolvedValue({ available: true });
  });

  it("keeps quick creation on the default work directory path", async () => {
    api.createProject.mockResolvedValue({ project: project() });
    const { result } = renderProjectsHook();

    await act(async () => {
      await result.current.createProjectNamed("默认项目");
    });

    expect(api.createProject).toHaveBeenCalledWith("access-token", {
      kind: "design",
      name: "默认项目",
    });
  });

  it("uses the picked path when creating a project", async () => {
    api.pickDirectory.mockResolvedValue({
      status: "picked",
      path: "/workspace/project",
    });
    api.createProject.mockResolvedValue({
      project: project("/workspace/project"),
    });
    const { result } = renderProjectsHook();
    await waitFor(() =>
      expect(result.current.directoryPickerAvailable).toBe(true),
    );

    await act(async () => {
      await result.current.createProjectFromDirectory("选定项目");
    });

    expect(api.pickDirectory).toHaveBeenCalledWith("access-token");
    expect(api.createProject).toHaveBeenCalledWith("access-token", {
      kind: "design",
      name: "选定项目",
      work_dir: "/workspace/project",
    });
  });

  it("does not create a project when directory selection is cancelled", async () => {
    api.pickDirectory.mockResolvedValue({ status: "cancelled" });
    const { result } = renderProjectsHook();

    await act(async () => {
      await result.current.createProjectFromDirectory("取消项目");
    });

    expect(api.createProject).not.toHaveBeenCalled();
  });

  it("opens the selected project directory through the desktop bridge", async () => {
    const { result } = renderProjectsHook();

    await act(async () => {
      await result.current.openProjectDirectory("/workspace/project");
    });

    expect(desktop.revealPath).toHaveBeenCalledWith("/workspace/project");
  });

  it("does not open the picker when the server says the old directory exists", async () => {
    api.fetchProjectDirectoryRelinkSnapshot.mockRejectedValue(
      new Error("原项目目录仍存在，不能重新关联。"),
    );
    const { result } = renderProjectsHook();

    await act(async () => {
      await result.current.relinkProjectDirectoryFromPicker("project-1");
    });

    expect(api.pickDirectory).not.toHaveBeenCalled();
    expect(api.relinkProjectDirectory).not.toHaveBeenCalled();
    expect(result.current.notice).toBe("原项目目录仍存在，不能重新关联。");
  });

  it("shows relink only after the server proves the selected root is missing", async () => {
    api.fetchProjects.mockResolvedValue({
      projects: [project("/workspace/project")],
    });
    api.fetchProjectDirectoryRelinkSnapshot.mockRejectedValueOnce(
      new Error("原项目目录仍存在，不能重新关联。"),
    );
    const existing = renderProjectsHook();
    await waitFor(() =>
      expect(existing.result.current.projects).toHaveLength(1),
    );
    await waitFor(() =>
      expect(api.fetchProjectDirectoryRelinkSnapshot).toHaveBeenCalled(),
    );
    expect(existing.result.current.relinkableProjectId).toBeNull();
    existing.unmount();

    vi.clearAllMocks();
    api.fetchProjects.mockResolvedValue({
      projects: [project("/missing/project")],
    });
    api.fetchProjectDirectoryRelinkSnapshot.mockResolvedValue({
      projectId: "project-1",
      workDir: "/missing/project",
      tasks: [],
    });
    const missing = renderProjectsHook();
    await waitFor(() =>
      expect(missing.result.current.relinkableProjectId).toBe("project-1"),
    );
  });

  it("does not post a relink when the directory picker is cancelled", async () => {
    api.fetchProjectDirectoryRelinkSnapshot.mockResolvedValue({
      projectId: "project-1",
      workDir: "/missing/project",
      tasks: [{ taskId: "task-1", scopeGeneration: 2, branchGeneration: 3 }],
    });
    api.pickDirectory.mockResolvedValue({ status: "cancelled" });
    const { result } = renderProjectsHook();

    await act(async () => {
      await result.current.relinkProjectDirectoryFromPicker("project-1");
    });

    expect(api.relinkProjectDirectory).not.toHaveBeenCalled();
    expect(result.current.relinkDraft).toBeNull();
  });

  it("preserves the picked directory after a relink failure", async () => {
    api.fetchProjectDirectoryRelinkSnapshot.mockResolvedValue({
      projectId: "project-1",
      workDir: "/missing/project",
      tasks: [],
    });
    api.pickDirectory.mockResolvedValue({
      status: "picked",
      path: "/workspace/replacement",
    });
    api.relinkProjectDirectory.mockRejectedValue(
      Object.assign(new Error("项目或Task已改变，请重新加载后关联。"), {
        status: 409,
      }),
    );
    const { result } = renderProjectsHook();

    await act(async () => {
      await result.current.relinkProjectDirectoryFromPicker("project-1");
    });

    expect(result.current.relinkDraft).toEqual({
      projectId: "project-1",
      path: "/workspace/replacement",
    });
    expect(api.relinkProjectDirectory).toHaveBeenCalledWith(
      "access-token",
      "project-1",
      {
        expectedWorkDir: "/missing/project",
        nextWorkDir: "/workspace/replacement",
        expectedTasks: [],
      },
    );
    expect(api.fetchProjectDirectoryRelinkSnapshot).toHaveBeenCalledTimes(1);
    expect(api.relinkProjectDirectory).toHaveBeenCalledTimes(1);
  });

  it("keeps the same project selected and refreshes the active Task after relink", async () => {
    api.fetchProjectDirectoryRelinkSnapshot.mockResolvedValue({
      projectId: "project-1",
      workDir: "/missing/project",
      tasks: [{ taskId: "task-1", scopeGeneration: 2, branchGeneration: 3 }],
    });
    api.pickDirectory.mockResolvedValue({
      status: "picked",
      path: "/workspace/replacement",
    });
    api.relinkProjectDirectory.mockResolvedValue({
      projectId: "project-1",
      workDir: "/workspace/replacement",
      tasks: [
        {
          taskId: "task-1",
          scopeGeneration: 3,
          branchGeneration: 4,
          status: "ready",
        },
      ],
    });
    api.fetchProjects.mockResolvedValue({
      projects: [project("/workspace/replacement")],
    });
    const frame = { postMessage: vi.fn() };
    const frameRef = {
      current: { contentWindow: frame } as unknown as HTMLIFrameElement,
    };
    const { result } = renderHook(() =>
      useDesignProjects("access-token", "design", frameRef),
    );
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    await act(async () => {
      await result.current.relinkProjectDirectoryFromPicker("project-1");
    });
    await waitFor(() =>
      expect(result.current.selectedProjectId).toBe("project-1"),
    );

    expect(result.current.relinkDraft).toBeNull();
    expect(api.fetchProjects).toHaveBeenLastCalledWith(
      "access-token",
      "design",
    );
    expect(frame.postMessage).toHaveBeenCalledWith(
      {
        type: "workbench:project-directory-relinked",
        projectId: "project-1",
        tasks: ["task-1"],
      },
      window.location.origin,
    );
  });

  it("creates Flow projects with a selected fixed directory", async () => {
    api.pickDirectory.mockResolvedValue({
      status: "picked",
      path: "/workspace/flow",
    });
    api.createProject.mockResolvedValue({
      project: project("/workspace/flow", "flow"),
    });
    const { result } = renderFlowProjectsHook();
    await waitFor(() =>
      expect(result.current.directoryPickerAvailable).toBe(true),
    );

    await act(async () => {
      await result.current.createProjectFromDirectory("Flow 项目");
    });

    expect(api.pickDirectory).toHaveBeenCalledWith("access-token");
    expect(api.createProject).toHaveBeenCalledWith("access-token", {
      kind: "flow",
      name: "Flow 项目",
      work_dir: "/workspace/flow",
    });
    expect(api.fetchProjectDirectoryRelinkSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.relinkProjectDirectoryFromPicker("project-1");
    });
    expect(api.fetchProjectDirectoryRelinkSnapshot).not.toHaveBeenCalled();
    expect(api.relinkProjectDirectory).not.toHaveBeenCalled();
  });
});
