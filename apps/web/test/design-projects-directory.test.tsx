import type { ProjectDirectoryRelinkResponse } from "@kenfutwork/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasProjectDirectory } from "@/components/workbench/zcode/host/canvasProjectDirectories";

const api = vi.hoisted(() => ({
  surfaceFetch: vi.fn(),
  surfaceJson: vi.fn(),
  localCuaDesktopInvoke: vi.fn(),
  desktopInvoke: vi.fn(),
}));
vi.mock("@/components/workbench/zcode/host/surfaceApi.js", () => api);
function requireSurfaceJsonCall(index: number) {
  const call = api.surfaceJson.mock.calls[index];
  if (!call) throw new Error(`Expected surfaceJson call ${index + 1}`);
  return call;
}
vi.mock("@/components/workbench/zcode/host/cuaPermissionPlatform.js", () => ({
  localCuaDesktopInvoke: api.localCuaDesktopInvoke,
}));
const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const snapshot = {
  projectId,
  workDir: "/missing/project",
  tasks: [{ taskId, scopeGeneration: 2, branchGeneration: 3 }],
};
const receipt = {
  projectId,
  workDir: "/workspace/replacement",
  affectedTaskIds: [taskId],
  tasks: [{ taskId, scopeGeneration: 3, branchGeneration: 4, status: "ready" }],
};
function mount() {
  return renderHook(() => useCanvasProjectDirectory("design", projectId));
}
async function create(kind: "design" | "flow", picked = false) {
  if (kind === "design")
    return (
      await import("@/components/workbench/zcode/host/designProjects")
    ).createDesignProject(picked);
  return (
    await import("@/components/workbench/zcode/host/flowProjects")
  ).createFlowProject(picked);
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  api.surfaceFetch.mockResolvedValue({ ok: true, json: async () => snapshot });
  api.localCuaDesktopInvoke.mockReturnValue(api.desktopInvoke);
  api.desktopInvoke.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
// These ten cases now exercise current stores/directory hooks. Real sidebar
// bridge gating and relink-to-canvas notification have consumer coverage in
// host-sidebar-directory-create.test.tsx; no retired UI or hook is imported.
describe("Design and Flow project directories in the current host", () => {
  it("keeps quick creation on the default work directory path", async () => {
    api.surfaceJson.mockResolvedValue({
      project: { id: projectId, kind: "design" },
    });
    await create("design");
    expect(api.surfaceJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(requireSurfaceJsonCall(0)[1].body)).toEqual({
      kind: "design",
      name: "未命名画布",
    });
  });
  it("uses the picked path when creating a project", async () => {
    api.surfaceJson
      .mockResolvedValueOnce({ status: "picked", path: "/workspace/project" })
      .mockResolvedValueOnce({ project: { id: projectId, kind: "design" } });
    await create("design", true);
    expect(requireSurfaceJsonCall(0)[0]).toBe("/api/system/pick-directory");
    expect(JSON.parse(requireSurfaceJsonCall(1)[1].body).work_dir).toBe(
      "/workspace/project",
    );
  });
  it("does not create a project when directory selection is cancelled", async () => {
    api.surfaceJson.mockResolvedValue({ status: "cancelled" });
    await create("design", true);
    expect(api.surfaceJson).toHaveBeenCalledTimes(1);
    expect(requireSurfaceJsonCall(0)[0]).toBe("/api/system/pick-directory");
  });
  it("opens the selected project directory through the existing desktop bridge", async () => {
    await api.localCuaDesktopInvoke()("reveal_path", {
      path: "/workspace/project",
    });
    expect(api.desktopInvoke).toHaveBeenCalledWith("reveal_path", {
      path: "/workspace/project",
    });
  });
  it("does not open the picker when the server says the old directory exists", async () => {
    api.surfaceFetch.mockResolvedValue({
      status: 400,
      json: async () => ({
        error: { message: "原项目目录仍存在，不能重新关联。" },
      }),
    });
    const hook = mount();
    await waitFor(() => expect(hook.result.current.checking).toBe(false));
    await act(async () => {
      await hook.result.current.recover();
    });
    expect(hook.result.current.snapshot).toBeNull();
    expect(api.surfaceJson).not.toHaveBeenCalled();
  });
  it("shows relink only after the server proves the selected root is missing", async () => {
    const hook = mount();
    expect(hook.result.current.snapshot).toBeNull();
    await waitFor(() =>
      expect(hook.result.current.snapshot?.projectId).toBe(projectId),
    );
    expect(api.surfaceFetch).toHaveBeenCalledWith(
      `/api/projects/${projectId}/relink-directory`,
    );
  });
  it("does not post a relink when the directory picker is cancelled", async () => {
    api.surfaceJson.mockResolvedValue({ status: "cancelled" });
    const hook = mount();
    await waitFor(() =>
      expect(hook.result.current.snapshot?.projectId).toBe(projectId),
    );
    await act(async () => {
      await hook.result.current.recover();
    });
    expect(api.surfaceJson).toHaveBeenCalledTimes(1);
    expect(requireSurfaceJsonCall(0)[0]).toBe("/api/system/pick-directory");
  });
  it("preserves the picked directory after a relink rejection with fresh Task fences", async () => {
    const refreshed = {
      ...snapshot,
      tasks: [{ taskId, scopeGeneration: 4, branchGeneration: 5 }],
    };
    api.surfaceJson
      .mockResolvedValueOnce({ status: "picked", path: receipt.workDir })
      .mockRejectedValueOnce(new Error("项目或Task已改变，请重新加载后关联。"))
      .mockResolvedValueOnce(refreshed);
    const hook = mount();
    await waitFor(() =>
      expect(hook.result.current.snapshot?.projectId).toBe(projectId),
    );
    await act(async () => {
      await hook.result.current.recover();
    });
    expect(hook.result.current.error).toContain("已改变");
    expect(JSON.parse(requireSurfaceJsonCall(1)[1].body)).toEqual({
      expectedWorkDir: snapshot.workDir,
      nextWorkDir: receipt.workDir,
      expectedTasks: snapshot.tasks,
    });
    api.surfaceJson.mockResolvedValueOnce(receipt);
    await act(async () => {
      await hook.result.current.recover();
    });
    expect(
      api.surfaceJson.mock.calls.filter(
        ([url]) => url === "/api/system/pick-directory",
      ),
    ).toHaveLength(1);
    expect(JSON.parse(requireSurfaceJsonCall(3)[1].body)).toEqual({
      expectedWorkDir: snapshot.workDir,
      nextWorkDir: receipt.workDir,
      expectedTasks: refreshed.tasks,
    });
  });
  it("keeps the same project binding and returns the receipt for refreshing its active Tasks", async () => {
    api.surfaceJson
      .mockResolvedValueOnce({ status: "picked", path: receipt.workDir })
      .mockResolvedValueOnce(receipt);
    const hook = mount();
    await waitFor(() =>
      expect(hook.result.current.snapshot?.projectId).toBe(projectId),
    );
    let recovered: ProjectDirectoryRelinkResponse | null = null;
    await act(async () => {
      recovered = await hook.result.current.recover();
    });
    expect(recovered).toEqual(receipt);
    await waitFor(() => expect(api.surfaceFetch).toHaveBeenCalledTimes(2));
    expect(hook.result.current.snapshot?.projectId).toBe(projectId);
  });
  it("creates Flow projects with a selected fixed directory", async () => {
    api.surfaceJson
      .mockResolvedValueOnce({ status: "picked", path: "/workspace/flow" })
      .mockResolvedValueOnce({ project: { id: projectId, kind: "flow" } });
    await create("flow", true);
    expect(JSON.parse(requireSurfaceJsonCall(1)[1].body)).toEqual({
      kind: "flow",
      name: "未命名工作流",
      work_dir: "/workspace/flow",
    });
    expect(api.surfaceFetch).not.toHaveBeenCalled();
  });
});
