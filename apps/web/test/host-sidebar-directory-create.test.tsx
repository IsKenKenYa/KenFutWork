import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFlowSurfaceView,
  navigateFlowSurface,
  registerFlowNavigate,
} from "@/components/workbench/zcode/host/flowSurfaceState";
import { HostModeSidebarContent } from "@/components/workbench/zcode/host/ModeSidebarContent";

const host = vi.hoisted(() => ({
  surfaceJson: vi.fn(),
  createDesignProject: vi.fn(),
  createFlowProject: vi.fn(),
  navigation: { mode: "flow", availableModes: ["flow"] },
  selectedPath: null as string | null,
  localCuaDesktopInvoke: vi.fn(),
  desktopInvoke: vi.fn(),
  recover: vi.fn(),
  refreshDesignProjects: vi.fn(),
  directorySnapshot: null as { projectId: string } | null,
  canvasFrameRef: { current: null as HTMLIFrameElement | null },
}));
vi.mock("@/components/workbench/zcode/host/cuaPermissionPlatform.js", () => ({
  localCuaDesktopInvoke: host.localCuaDesktopInvoke,
}));
vi.mock("@zui/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({
    workbenchNavigation: {
      subscribe: () => () => {},
      getSnapshot: () => host.navigation,
    },
  }),
}));
vi.mock("@/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: host.surfaceJson,
}));
vi.mock(
  "@/components/workbench/zcode/host/canvasProjectDirectories.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/workbench/zcode/host/canvasProjectDirectories")
    >()),
    useCanvasProjectDirectory: () => ({
      snapshot: host.directorySnapshot,
      error: null,
      recover: host.recover,
      busy: false,
    }),
  }),
);
vi.mock("@/components/workbench/zcode/host/flowProjects.js", () => ({
  createFlowProject: host.createFlowProject,
  useFlowProjectsController: () => {},
  selectFlowProject: vi.fn(),
  useFlowProjectsSnapshot: () => ({
    projects: host.selectedPath
      ? [{ id: "project", name: "项目", workDir: host.selectedPath }]
      : [],
    selectedProjectId: host.selectedPath ? "project" : null,
    creating: false,
    notice: null,
  }),
}));
beforeEach(() => {
  vi.resetAllMocks();
  host.selectedPath = null;
  host.directorySnapshot = null;
  registerFlowNavigate(null);
  host.surfaceJson.mockResolvedValue({ available: false });
  host.localCuaDesktopInvoke.mockReturnValue(null);
  host.desktopInvoke.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  host.canvasFrameRef.current?.remove();
  host.canvasFrameRef.current = null;
});
describe.each(["flow"] as const)("%s sidebar directory creation", (kind) => {
  function mount() {
    return render(<HostModeSidebarContent />);
  }
  it("hides directory creation when the server picker is unavailable", async () => {
    host.surfaceJson.mockResolvedValue({ available: false });
    mount();
    await waitFor(() =>
      expect(host.surfaceJson).toHaveBeenCalledWith(
        "/api/system/directory-picker",
      ),
    );
    expect(screen.queryByRole("button", { name: "选目录新建" })).toBeNull();
  });
  it("exposes a real optional directory creation action only after the server probe", async () => {
    host.surfaceJson.mockResolvedValue({ available: true });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "选目录新建" }));
    expect(host.createFlowProject).toHaveBeenCalledWith(true);
  });
  it("opens precisely the selected directory using the existing native bridge", async () => {
    host.selectedPath = "/selected project root";
    host.localCuaDesktopInvoke.mockReturnValue(host.desktopInvoke);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    await waitFor(() =>
      expect(host.desktopInvoke).toHaveBeenCalledWith("reveal_path", {
        path: "/selected project root",
      }),
    );
  });
  it("does not expose a native directory action in the browser", () => {
    host.selectedPath = "/selected project root";
    host.localCuaDesktopInvoke.mockReturnValue(null);
    mount();
    expect(screen.queryByRole("button", { name: "打开目录" })).toBeNull();
    expect(host.desktopInvoke).not.toHaveBeenCalled();
  });
});

it("gates Flow sidebar navigation by project and connected iframe readiness", () => {
  host.navigation.mode = "flow";
  const view = render(<HostModeSidebarContent />);
  const workflow = screen.getByRole("button", { name: "工作流" });
  const plugins = screen.getByRole("button", { name: "工作流插件" });
  const tasks = screen.getByRole("button", { name: "任务中心" });
  expect(workflow).toBeDisabled();
  expect(plugins).toBeDisabled();
  expect(tasks).toBeDisabled();

  host.selectedPath = "/flow-project";
  view.rerender(<HostModeSidebarContent />);
  expect(workflow).toBeEnabled();
  expect(plugins).toBeDisabled();
  expect(tasks).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "引擎" }));
  expect(getFlowSurfaceView()).toBe("engine");
  fireEvent.click(workflow);
  expect(getFlowSurfaceView()).toBe("canvas");

  const navigate = vi.fn();
  act(() => registerFlowNavigate(navigate));
  expect(plugins).toBeEnabled();
  expect(tasks).toBeEnabled();
  fireEvent.click(plugins);
  expect(navigate).toHaveBeenCalledWith("/plugins");
  act(() => registerFlowNavigate(null));
});

import "@testing-library/jest-dom/vitest";
