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
  missing: false,
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
  it("hides Design recovery when the project directory is still online", async () => {
    api.surfaceFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        projectId,
        workDir: "/p",
        tasks: [],
        missing: false,
      }),
    });
    const hook = renderHook(() =>
      useCanvasProjectDirectory("design", projectId),
    );
    await waitFor(() => expect(hook.result.current.checking).toBe(false));
    expect(hook.result.current.snapshot).toBeNull();
    expect(api.surfaceJson).not.toHaveBeenCalled();
  });
  it("shows Design recovery only when the directory is actually missing", async () => {
    api.surfaceFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ projectId, workDir: "/p", tasks: [], missing: true }),
    });
    const hook = renderHook(() =>
      useCanvasProjectDirectory("design", projectId),
    );
    await waitFor(() =>
      expect(hook.result.current.snapshot?.missing).toBe(true),
    );
    expect(hook.result.current.error).toBeNull();
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
  it("re-reads a failed directory check on its own once the gateway recovers", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      api.surfaceFetch.mockImplementation(async () => {
        calls += 1;
        return calls === 1
          ? {
              status: 503,
              json: async () => ({
                error: { message: "Flow状态不可读取，请恢复网关连接。" },
              }),
            }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                projectId,
                workDir: "/p",
                tasks: [],
                missing: false,
                flow: {
                  generation: 1,
                  operationId,
                  phase: "available",
                  previousWorkDir: "/p",
                  nextWorkDir: null,
                  receipt: null,
                },
              }),
            };
      });
      const hook = renderHook(() =>
        useCanvasProjectDirectory("flow", projectId),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(hook.result.current.error).toContain("恢复网关连接");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(hook.result.current.snapshot?.flow?.phase).toBe("available");
      expect(hook.result.current.error).toBeNull();
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps the message readable when the host answers 500 with plain text", async () => {
    api.surfaceFetch.mockResolvedValue({
      status: 500,
      json: async () => {
        throw new SyntaxError(
          `Unexpected token 'I', "Internal S"... is not valid JSON`,
        );
      },
    });
    const hook = renderHook(() => useCanvasProjectDirectory("flow", projectId));
    await waitFor(() =>
      expect(hook.result.current.error).toBe("项目目录状态无法读取。"),
    );
    hook.unmount();
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
