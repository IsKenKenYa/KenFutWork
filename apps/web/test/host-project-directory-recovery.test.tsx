import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasProjectDirectory } from "@/components/workbench/zcode/host/canvasProjectDirectories";

const api = vi.hoisted(() => ({ surfaceFetch: vi.fn(), surfaceJson: vi.fn() }));
vi.mock("@/components/workbench/zcode/host/surfaceApi.js", () => api);
function requireSurfaceJsonCall(index: number) {
  const call = api.surfaceJson.mock.calls[index];
  if (!call) throw new Error(`Expected surfaceJson call ${index + 1}`);
  return call;
}
const projectId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const snapshot = {
  projectId,
  workDir: "/next",
  tasks: [],
  flow: {
    generation: 2,
    operationId,
    phase: "root_published",
    previousWorkDir: "/old",
    nextWorkDir: "/next",
    receipt: null,
  },
};
describe("new-shell project directory recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it("hides Design recovery when the server rejects a recovery snapshot", async () => {
    api.surfaceFetch.mockResolvedValue({
      status: 400,
      json: async () => ({
        error: { message: "原项目目录仍存在，不能重新关联。" },
      }),
    });
    const hook = renderHook(() =>
      useCanvasProjectDirectory("design", projectId),
    );
    await waitFor(() => expect(hook.result.current.checking).toBe(false));
    expect(hook.result.current.snapshot).toBeNull();
    expect(api.surfaceJson).not.toHaveBeenCalled();
  });
  it("shows a failed directory check while keeping recovery hidden", async () => {
    api.surfaceFetch.mockResolvedValue({
      status: 400,
      json: async () => ({
        error: { message: "旧目录无法确认缺失，请检查目录权限。" },
      }),
    });
    const hook = renderHook(() =>
      useCanvasProjectDirectory("design", projectId),
    );
    await waitFor(() =>
      expect(hook.result.current.error).toContain("目录权限"),
    );
    expect(hook.result.current.snapshot).toBeNull();
  });
  it("continues the published Flow operation without opening another picker", async () => {
    api.surfaceFetch.mockResolvedValue({
      ok: true,
      json: async () => snapshot,
    });
    api.surfaceJson.mockResolvedValue({
      projectId,
      workDir: "/next",
      tasks: [],
      affectedTaskIds: [],
      flow: { ...snapshot.flow, phase: "complete_unknown" },
    });
    const hook = renderHook(() => useCanvasProjectDirectory("flow", projectId));
    await waitFor(() =>
      expect(hook.result.current.snapshot?.flow?.phase).toBe("root_published"),
    );
    await act(async () => {
      await hook.result.current.recover();
    });
    const [url, init] = requireSurfaceJsonCall(0);
    expect(url).toBe(`/api/projects/${projectId}/relink-directory`);
    expect(JSON.parse(init.body)).toEqual({
      expectedWorkDir: "/old",
      nextWorkDir: "/next",
      expectedTasks: [],
      expectedFlow: { generation: 2, operationId },
    });
    expect(hook.result.current.snapshot?.flow?.phase).toBe("complete_unknown");
    expect(hook.result.current.error).toContain("同一操作");
  });
  it("retains the chosen target and operation when submission and status replies are lost", async () => {
    api.surfaceFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...snapshot,
        workDir: "/old",
        flow: { ...snapshot.flow, phase: "idle", nextWorkDir: null },
      }),
    });
    api.surfaceJson
      .mockResolvedValueOnce({ status: "picked", path: "/next" })
      .mockRejectedValueOnce(new Error("response lost"))
      .mockRejectedValueOnce(new Error("status unavailable"));
    const hook = renderHook(() => useCanvasProjectDirectory("flow", projectId));
    await waitFor(() =>
      expect(hook.result.current.snapshot?.flow?.phase).toBe("idle"),
    );
    await act(async () => {
      await hook.result.current.recover();
    });
    expect(hook.result.current.snapshot?.flow).toMatchObject({
      operationId,
      nextWorkDir: "/next",
      phase: "staged",
    });
    api.surfaceJson.mockRejectedValueOnce(new Error("still unavailable"));
    await act(async () => {
      await hook.result.current.recover();
    });
    expect(requireSurfaceJsonCall(3)).toEqual([
      `/api/projects/${projectId}/relink-directory`,
    ]);
    expect(hook.result.current.error).toBe("still unavailable");
    api.surfaceJson.mockResolvedValueOnce(snapshot);
    await act(async () => {
      await hook.result.current.recover();
    });
    expect(requireSurfaceJsonCall(4)).toEqual([
      `/api/projects/${projectId}/relink-directory`,
    ]);
    api.surfaceJson.mockResolvedValueOnce({
      projectId,
      workDir: "/next",
      tasks: [],
      affectedTaskIds: [],
      flow: { ...snapshot.flow, phase: "complete_unknown" },
    });
    await act(async () => {
      await hook.result.current.recover();
    });
    expect(
      api.surfaceJson.mock.calls.filter(
        ([url]) => url === "/api/system/pick-directory",
      ),
    ).toHaveLength(1);
    expect(JSON.parse(requireSurfaceJsonCall(5)[1].body).expectedFlow).toEqual({
      generation: 2,
      operationId,
    });
  });
});
