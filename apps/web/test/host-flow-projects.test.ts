import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  surfaceJson: vi.fn(),
  surfaceRequest: vi.fn(),
}));
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
afterEach(cleanup);
it("creates a Flow project with the server-managed default directory", async () => {
  api.surfaceJson.mockResolvedValue({
    project: { id: "flow-project", kind: "flow", name: "未命名工作流" },
  });
  const { createFlowProject } = await import(
    "@/components/workbench/zcode/host/flowProjects"
  );
  await createFlowProject();
  expect(api.surfaceJson).toHaveBeenCalledTimes(1);
  const [path, init] = requireSurfaceJsonCall(0);
  expect(path).toBe("/api/projects");
  expect(JSON.parse(init.body)).toEqual({ kind: "flow", name: "未命名工作流" });
});
it("renames a project without touching its directory or modes", async () => {
  mockProjectLists({
    flow: [
      {
        id: "flow-1",
        kind: "flow",
        name: "旧名字",
        workDir: "/flow-project",
      },
    ],
  });
  api.surfaceRequest.mockResolvedValue({ ok: true });
  const store = await import("@/components/workbench/zcode/host/flowProjects");
  await store.refreshFlowProjects();
  await store.renameProject("flow-1", " 出差报销 ");
  expect(api.surfaceRequest).toHaveBeenCalledWith("/api/projects/flow-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "出差报销" }),
  });
  const hook = renderHook(() => store.useFlowProjectsSnapshot());
  expect(hook.result.current.projects[0]).toMatchObject({
    id: "flow-1",
    name: "出差报销",
    workDir: "/flow-project",
  });
});
it("ignores an older project read after creating and selecting a Flow project", async () => {
  let resolveRead: ((value: { projects: unknown[] }) => void) | undefined;
  const oldRead = new Promise<{ projects: unknown[] }>((resolve) => {
    resolveRead = resolve;
  });
  const project = { id: "flow-project", kind: "flow", name: "未命名工作流" };
  let listReadStarted = false;
  api.surfaceJson.mockImplementation((_path: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve({ project });
    if (!listReadStarted) {
      listReadStarted = true;
      return oldRead;
    }
    return Promise.resolve({ projects: [] });
  });
  const store = await import("@/components/workbench/zcode/host/flowProjects");
  const hook = renderHook(() => store.useFlowProjectsSnapshot());
  const pendingRead = store.refreshFlowProjects();
  await act(async () => {
    await store.createFlowProject();
  });
  expect(hook.result.current.selectedProjectId).toBe(project.id);
  await act(async () => {
    resolveRead?.({ projects: [] });
    await pendingRead;
  });
  expect(hook.result.current.projects).toEqual([project]);
  expect(hook.result.current.selectedProjectId).toBe(project.id);
});

function mockProjectLists(byKind: Record<string, unknown[]>) {
  api.surfaceJson.mockImplementation((path: string) => {
    const kind =
      new URLSearchParams(path.split("?")[1] ?? "").get("kind") ?? "";
    return Promise.resolve({ projects: byKind[kind] ?? [] });
  });
}

it("binds an existing Flow project when nothing is selected", async () => {
  mockProjectLists({
    flow: [{ id: "flow-1", kind: "flow", name: "工作流 A" }],
  });
  const store = await import("@/components/workbench/zcode/host/flowProjects");
  await store.refreshFlowProjects();
  const hook = renderHook(() => store.useFlowProjectsSnapshot());
  expect(hook.result.current.selectedProjectId).toBe("flow-1");
  expect(
    api.surfaceJson.mock.calls.some(([, init]) => init?.method === "POST"),
  ).toBe(false);
});

it("creates and selects the default Flow project when none exists", async () => {
  mockProjectLists({});
  api.surfaceJson.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST")
      return Promise.resolve({
        project: { id: "default-flow", kind: "flow", name: "默认工作流" },
      });
    const kind =
      new URLSearchParams(path.split("?")[1] ?? "").get("kind") ?? "";
    return Promise.resolve({ projects: [] }); // 已有项目但都不是 flow
  });
  const store = await import("@/components/workbench/zcode/host/flowProjects");
  await store.refreshFlowProjects();
  const hook = renderHook(() => store.useFlowProjectsSnapshot());
  expect(hook.result.current.selectedProjectId).toBe("default-flow");
  const post = api.surfaceJson.mock.calls.find(
    ([, init]) => init?.method === "POST",
  );
  expect(JSON.parse(post?.[1]?.body ?? "{}")).toEqual({
    kind: "flow",
    name: "默认工作流",
  });
});

it("keeps an explicitly bound Code project instead of the default", async () => {
  mockProjectLists({
    code: [{ id: "code-1", kind: "code", name: "代码项目", workDir: "/tmp" }],
    flow: [{ id: "flow-1", kind: "flow", name: "工作流 A" }],
  });
  const store = await import("@/components/workbench/zcode/host/flowProjects");
  store.selectFlowProject("code-1");
  await store.refreshFlowProjects();
  const hook = renderHook(() => store.useFlowProjectsSnapshot());
  expect(hook.result.current.selectedProjectId).toBe("code-1");
});
