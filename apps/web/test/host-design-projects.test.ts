import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ surfaceJson: vi.fn() }));
vi.mock("@/components/workbench/zcode/host/surfaceApi.js", () => api);
function requireSurfaceJsonCall(index: number) {
  const call = api.surfaceJson.mock.calls[index];
  if (!call) throw new Error(`Expected surfaceJson call ${index + 1}`);
  return call;
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});
it("creates a Design project in the server-managed directory by default", async () => {
  api.surfaceJson.mockResolvedValue({
    project: { id: "design-project", kind: "design" },
  });
  const { createDesignProject } = await import(
    "@/components/workbench/zcode/host/designProjects"
  );
  await createDesignProject();
  expect(api.surfaceJson).toHaveBeenCalledTimes(1);
  expect(requireSurfaceJsonCall(0)[0]).toBe("/api/projects");
  expect(JSON.parse(requireSurfaceJsonCall(0)[1].body)).toEqual({
    kind: "design",
    name: "未命名项目",
  });
});
it("passes the selected Design directory without changing its path", async () => {
  api.surfaceJson
    .mockResolvedValueOnce({ status: "picked", path: "/explicit design" })
    .mockResolvedValueOnce({
      project: { id: "design-project", kind: "design" },
    });
  const { createDesignProject } = await import(
    "@/components/workbench/zcode/host/designProjects"
  );
  await createDesignProject(true);
  expect(requireSurfaceJsonCall(0)[0]).toBe("/api/system/pick-directory");
  expect(JSON.parse(requireSurfaceJsonCall(1)[1].body).work_dir).toBe(
    "/explicit design",
  );
});
it("does not create a Design project after cancelling its picker", async () => {
  api.surfaceJson.mockResolvedValue({ status: "cancelled" });
  const { createDesignProject } = await import(
    "@/components/workbench/zcode/host/designProjects"
  );
  await createDesignProject(true);
  expect(api.surfaceJson).toHaveBeenCalledTimes(1);
  expect(requireSurfaceJsonCall(0)[0]).toBe("/api/system/pick-directory");
});
it("ignores an older project read after creating and selecting a Design project", async () => {
  let resolveRead: ((value: { projects: unknown[] }) => void) | undefined;
  const oldRead = new Promise<{ projects: unknown[] }>((resolve) => {
    resolveRead = resolve;
  });
  const project = { id: "design-project", kind: "design" };
  api.surfaceJson
    .mockReturnValueOnce(oldRead)
    .mockResolvedValueOnce({ project });
  const store = await import(
    "@/components/workbench/zcode/host/designProjects"
  );
  const pendingRead = store.refreshDesignProjects("old-project");
  await store.createDesignProject();
  expect(store.getDesignProjectsSnapshot().selectedProjectId).toBe(project.id);
  resolveRead?.({ projects: [{ id: "old-project", kind: "design" }] });
  await pendingRead;
  expect(store.getDesignProjectsSnapshot().projects).toEqual([project]);
  expect(store.getDesignProjectsSnapshot().selectedProjectId).toBe(project.id);
});
