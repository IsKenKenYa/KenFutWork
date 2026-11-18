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
  registerFlowNavigate,
} from "@/components/workbench/zcode/host/flowSurfaceState";
import { HostModeSidebarContent } from "@/components/workbench/zcode/host/ModeSidebarContent";

const host = vi.hoisted(() => ({
  surfaceJson: vi.fn(),
  createDesignProject: vi.fn(),
  createFlowProject: vi.fn(),
  renameProject: vi.fn(),
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
  listProjects: vi.fn(async () => []),
  renameProject: host.renameProject,
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
describe("flow sidebar directory creation", () => {
  function mount() {
    return render(<HostModeSidebarContent />);
  }
  it("does not expose a directory-backed project creation action", () => {
    host.selectedPath = "/flow-project";
    mount();
    expect(screen.queryByRole("button", { name: "选目录新建" })).toBeNull();
  });
  it("keeps the project dropdown until rename is clicked, then edits inline", async () => {
    host.selectedPath = "/flow-project";
    host.renameProject.mockResolvedValue(undefined);
    mount();
    expect(screen.getByRole("combobox", { name: "Flow 项目" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "重命名项目" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重命名项目" }));
    const input = screen.getByRole("textbox", { name: "项目名称" });
    // 与下拉触发器同款：不透明白底（h-7），左内边距对齐下方导航图标。
    expect(input.className).toContain("bg-transparent");
    expect(input.className).toContain("h-7");
    expect(input.className).toContain("!pl-3");
    fireEvent.change(input, { target: { value: "出差报销" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(host.renameProject).toHaveBeenCalledWith("project", "出差报销"),
    );
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

it("keeps Flow navigation usable while the iframe handshake is still pending", () => {
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
  expect(plugins).toBeEnabled();
  expect(tasks).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "引擎" }));
  expect(getFlowSurfaceView()).toBe("engine");
  fireEvent.click(workflow);
  expect(getFlowSurfaceView()).toBe("canvas");

  fireEvent.click(plugins);
  const navigate = vi.fn();
  act(() => registerFlowNavigate(navigate));
  expect(navigate).toHaveBeenCalledWith("/plugins");
  act(() => registerFlowNavigate(null));
});

import "@testing-library/jest-dom/vitest";
