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
  kind: "flow" as "flow" | "code" | "design" | "work",
  snapshot: null as ProjectDirectoryRelinkSnapshot | null,
  checking: false,
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
  useFlowProjectsSnapshot: () => ({
    selectedProjectId: host.projectId,
    projects: host.projectId
      ? [{ id: host.projectId, kind: host.kind, name: "项目" }]
      : [],
  }),
  refreshFlowProjects: host.refreshFlowProjects,
}));
vi.mock(
  "@/components/workbench/zcode/host/canvasProjectDirectories.js",
  () => ({
    useCanvasProjectDirectory: () => ({
      snapshot: host.snapshot,
      checking: host.checking,
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
  host.kind = "flow";
  host.snapshot = null;
  host.checking = false;
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
    // 屏障：反复发 hello 直到监听器就位并触发挂起的换票（一次性 mockImplementationOnce
    // 若被新项目的 hello 消费，identity 永远发不出去；CI 上 effect 落地偶发晚于首帧）。
    await waitFor(
      () => {
        message(oldSource, { type: "ff-embed/hello", version: "v1" });
        expect(host.surfaceFetch).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );
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

it("binds a Code project without waiting for a flow relink snapshot", async () => {
  // 非 Flow 项目没有目录迁移状态（快照为 null 且不请求 relink），项目存在于列表即可绑定。
  host.kind = "code";
  host.projectId = projectA;
  host.snapshot = null;
  render(<HostFlowSurface />);
  await screen.findByTitle("Flow 工作流画布");
  await handshake(frameWindow());
  expect(host.surfaceFetch).toHaveBeenCalledWith(
    "/api/flow/host/identity-ticket",
    expect.objectContaining({
      body: JSON.stringify({ projectId: projectA }),
    }),
  );
});

it("shows the unified startup animation while the directory check is running", async () => {
  host.projectId = projectA;
  host.snapshot = null;
  host.checking = true;
  render(<HostFlowSurface />);
  await waitFor(() => {
    const busy = document.querySelector('[role="status"][aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy?.querySelector('[class*="animate-spin"]')).not.toBeNull();
  });
  const busy = document.querySelector('[role="status"][aria-busy="true"]');
  expect(busy?.getAttribute("aria-label")).toBe("检查目录");
  expect(busy?.textContent).toBe("");
  expect(screen.queryByText("检查目录…")).toBeNull();
});

function engineInfoResponse(
  stack: { containers: unknown[]; error?: string },
  installState: "idle" | "installing" | "ready" | "error" = "idle",
) {
  return {
    install: { state: installState, logTail: [] },
    probe: { platform: "win32", paths: [], recommended: null },
    stack,
    runtime: { kind: "host" },
    addresses: {
      frontendUrl: `${origin}/`,
      hostIdentityUrl: "http://127.0.0.1:3001/api/flow/host/identity/verify",
      composeFile: "D:/KenFutWork/dify/docker-compose.dify.yml",
      dataDir: "D:/data",
    },
  };
}

async function mountEngineView(info: unknown) {
  host.projectId = projectA;
  host.kind = "flow";
  host.snapshot = binding(projectA, 1);
  setFlowSurfaceView("engine");
  host.surfaceJson.mockImplementation(async (url: string) =>
    url === "/api/flow/host/engine/info"
      ? info
      : { enabled: true, frontendUrl: `${origin}/`, reasons: [] },
  );
  render(<HostFlowSurface />);
}

it("reports a failed container query as an unknown state instead of uninstalled", async () => {
  // Docker 无响应时 compose 查询报错：不能显示「未安装」，也不把整条命令搬进界面。
  await mountEngineView(
    engineInfoResponse({
      containers: [],
      error:
        "docker compose ps 失败（退出码 127）：Command failed: docker compose --env-file D:/data/dify-stack.env -f D:/KenFutWork/dify/docker-compose.dify.yml --profile dify ps --format json",
    }),
  );
  await screen.findByText("状态未知");
  expect(screen.queryByText("未安装")).toBeNull();
  expect(screen.getByText(/容器清单读取失败/).getAttribute("title")).toContain(
    "--format json",
  );
  expect(screen.queryByText(/Command failed: docker compose/)).toBeNull();
  setFlowSurfaceView("canvas");
});

it("shows an installed stack as ready after the host process restarts", async () => {
  // 安装记录随进程归零（idle）；容器事实仍在跑，状态必须是「已就绪」。
  await mountEngineView(
    engineInfoResponse({
      containers: [
        {
          service: "dify",
          name: "kenfutwork-dify-dify-1",
          state: "running",
          health: "healthy",
          ports: ["127.0.0.1:15001->5001/tcp"],
        },
      ],
    }),
  );
  await screen.findByText("已就绪");
  setFlowSurfaceView("canvas");
});
