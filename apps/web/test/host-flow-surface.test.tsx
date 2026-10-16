import type { ProjectDirectoryRelinkSnapshot } from "@kenfutwork/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostFlowSurface } from "@/components/workbench/zcode/host/FlowSurface";
import {
  getFlowNavigationReady,
  navigateFlowSurface,
  setFlowSurfaceView,
} from "@/components/workbench/zcode/host/flowSurfaceState";

const host = vi.hoisted(() => ({
  projectId: null as string | null,
  snapshot: null as ProjectDirectoryRelinkSnapshot | null,
  surfaceFetch: vi.fn(),
  surfaceJson: vi.fn(),
  recover: vi.fn(),
  refreshFlowProjects: vi.fn(),
}));
vi.mock("@/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceFetch: host.surfaceFetch,
  surfaceJson: host.surfaceJson,
}));
vi.mock("@/components/workbench/zcode/host/flowProjects.js", () => ({
  useFlowProjectsSnapshot: () => ({ selectedProjectId: host.projectId }),
  refreshFlowProjects: host.refreshFlowProjects,
}));
vi.mock(
  "@/components/workbench/zcode/host/canvasProjectDirectories.js",
  () => ({
    useCanvasProjectDirectory: () => ({
      snapshot: host.snapshot,
      checking: false,
      error: null,
      busy: false,
      recover: host.recover,
    }),
  }),
);
const projectA = "11111111-1111-4111-8111-111111111111";
const projectB = "22222222-2222-4222-8222-222222222222";
const origin = "http://127.0.0.1:8080";
function binding(
  projectId: string,
  generation: number,
): ProjectDirectoryRelinkSnapshot {
  return {
    projectId,
    workDir: "/project",
    tasks: [],
    flow: {
      generation,
      operationId: "33333333-3333-4333-8333-333333333333",
      phase: "available",
      previousWorkDir: "/project",
      nextWorkDir: null,
      receipt: null,
    },
  };
}
function select(projectId: string, generation: number) {
  host.projectId = projectId;
  host.snapshot = binding(projectId, generation);
}
function frameWindow() {
  const frame = screen.getByTitle<HTMLIFrameElement>("Flow 工作流画布");
  if (!frame.contentWindow) throw new Error("Missing iframe window");
  return frame.contentWindow;
}
function message(source: Window, data: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { origin, source, data }));
  });
}
function ready(source: Window, projectId: string, generation: number) {
  message(source, {
    type: "ff-embed/ready",
    projectId,
    generation,
    extensions: { projectFiles: "v1" },
  });
}
async function handshake(source: Window) {
  const outbound = vi.spyOn(source, "postMessage");
  message(source, { type: "ff-embed/hello", version: "v1" });
  await waitFor(() =>
    expect(outbound).toHaveBeenCalledWith(
      { type: "ff-embed/identity", version: "v1", hostToken: "ticket" },
      origin,
    ),
  );
  return outbound;
}
beforeEach(() => {
  vi.resetAllMocks();
  host.projectId = null;
  host.snapshot = null;
  setFlowSurfaceView("canvas");
  host.surfaceJson.mockResolvedValue({
    enabled: true,
    frontendUrl: `${origin}/`,
    reasons: [],
  });
  host.surfaceFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ token: "ticket" }),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FlowSurface project binding consumer", () => {
  it("waits for a selected project without creating an iframe or requesting identity", async () => {
    render(<HostFlowSurface />);
    await screen.findByText("选择项目");
    expect(screen.queryByTitle("Flow 工作流画布")).toBeNull();
    expect(host.surfaceFetch).not.toHaveBeenCalled();
  });
  it("requests a project-bound ticket and opens navigation only for the authoritative generation", async () => {
    select(projectA, 2);
    const view = render(<HostFlowSurface />);
    await screen.findByTitle("Flow 工作流画布");
    const source = frameWindow();
    const outbound = await handshake(source);
    expect(host.surfaceFetch).toHaveBeenCalledWith(
      "/api/flow/host/identity-ticket",
      expect.objectContaining({
        body: JSON.stringify({ projectId: projectA }),
      }),
    );
    outbound.mockClear();
    ready(source, projectA, 1);
    act(() => navigateFlowSurface("/tasks"));
    expect(outbound).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("绑定不匹配");
    ready(source, projectA, 2);
    await waitFor(() => expect(getFlowNavigationReady()).toBe(true));
    act(() => navigateFlowSurface("/tasks"));
    expect(outbound).toHaveBeenCalledWith(
      { type: "ff-embed/navigate", version: "v1", path: "/tasks" },
      origin,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount();
    expect(getFlowNavigationReady()).toBe(false);
  });
  it("replaces the old iframe on a confirmed generation change and ignores its late ready", async () => {
    select(projectA, 2);
    const view = render(<HostFlowSurface />);
    await screen.findByTitle("Flow 工作流画布");
    const oldFrame = screen.getByTitle("Flow 工作流画布");
    const oldSource = frameWindow();
    await handshake(oldSource);
    ready(oldSource, projectA, 2);
    select(projectA, 3);
    view.rerender(<HostFlowSurface />);
    const newSource = frameWindow();
    expect(screen.getByTitle("Flow 工作流画布")).not.toBe(oldFrame);
    const outbound = await handshake(newSource);
    outbound.mockClear();
    ready(oldSource, projectA, 3);
    message(oldSource, { type: "ff-embed/error" });
    act(() => navigateFlowSurface("/tasks"));
    expect(outbound).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    ready(newSource, projectA, 3);
    // ready 被组件接受是异步的（状态落在下一个 microtask）；不等门就 navigate 会偶发丢消息。
    await waitFor(() => expect(getFlowNavigationReady()).toBe(true));
    act(() => navigateFlowSurface("/tasks"));
    expect(outbound).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ff-embed/navigate" }),
      origin,
    );
  });
  it("discards a ticket response and ready arriving from the previous selected project", async () => {
    let resolveTicket:
      | ((response: {
          ok: boolean;
          json: () => Promise<{ token: string }>;
        }) => void)
      | undefined;
    host.surfaceFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTicket = resolve;
        }),
    );
    select(projectA, 2);
    const view = render(<HostFlowSurface />);
    await screen.findByTitle("Flow 工作流画布");
    const oldSource = frameWindow();
    const oldOutbound = vi.spyOn(oldSource, "postMessage");
    message(oldSource, { type: "ff-embed/hello", version: "v1" });
    // 屏障：必须确认「挂起的那次换票」确实被旧项目的 hello 触发，否则一次性的
    // mockImplementationOnce 会被新项目的 hello 消费掉，identity 永远发不出去（负载下偶发）。
    await waitFor(() => expect(host.surfaceFetch).toHaveBeenCalledTimes(1));
    select(projectB, 1);
    view.rerender(<HostFlowSurface />);
    const newSource = frameWindow();
    const outbound = await handshake(newSource);
    outbound.mockClear();
    oldOutbound.mockClear();
    await act(async () => {
      resolveTicket?.({
        ok: true,
        json: async () => ({ token: "old-ticket" }),
      });
    });
    ready(oldSource, projectB, 1);
    act(() => navigateFlowSurface("/tasks"));
    expect(oldOutbound).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
    ready(newSource, projectB, 1);
    // 同上：等组件真的接受权威 ready 再 navigate，否则断言打在异步落地之前，CI 负载下偶发红。
    await waitFor(() => expect(getFlowNavigationReady()).toBe(true));
    act(() => navigateFlowSurface("/tasks"));
    expect(outbound).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ff-embed/navigate" }),
      origin,
    );
  });
});
