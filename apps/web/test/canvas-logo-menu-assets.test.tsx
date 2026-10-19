import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exportAssets: vi.fn(),
  restoreAssets: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@/lib/server-api", () => ({
  deleteProject: vi.fn(),
  exportCanvasAssets: mocks.exportAssets,
  restoreCanvasAssets: mocks.restoreAssets,
}));
vi.mock("@/components/toast", () => ({
  useToast: () => ({ error: mocks.toastError }),
}));

import { CanvasLogoMenu } from "../src/components/canvas-logo-menu";

const props = {
  accessToken: "token",
  projectId: "project-1",
  canvasId: "canvas-1",
  projectName: "Canvas",
  excalidrawApi: null,
  onCanvasSync: vi.fn(async () => {}),
  onNewProject: vi.fn(),
};
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
function renderMenu(prepareCanvas: () => Promise<string | null>) {
  return render(<CanvasLogoMenu {...props} prepareCanvas={prepareCanvas} />);
}
async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "菜单" }));
}

describe("CanvasLogoMenu asset actions", () => {
  beforeEach(() => {
    mocks.exportAssets.mockReset().mockResolvedValue(new Blob(["archive"]));
    mocks.restoreAssets
      .mockReset()
      .mockResolvedValue({ revision: "revision-2", assetIds: [] });
    mocks.toastError.mockReset();
    props.onCanvasSync.mockClear();
    props.onNewProject.mockClear();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:archive",
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: () => {},
    });
  });
  afterEach(() => {
    cleanup();
    if (originalCreateObjectURL)
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
    else delete (URL as Partial<typeof URL>).createObjectURL;
    if (originalRevokeObjectURL)
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
    else delete (URL as Partial<typeof URL>).revokeObjectURL;
  });

  it("exports with the revision returned by flushing the current canvas", async () => {
    const prepareCanvas = vi.fn(async () => "revision-after-save");
    renderMenu(prepareCanvas);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /导出素材包/ }));
    await waitFor(() =>
      expect(mocks.exportAssets).toHaveBeenCalledWith(
        "token",
        "canvas-1",
        "revision-after-save",
      ),
    );
  });

  it("requests a new project from the shared workbench without creating a canvas", async () => {
    renderMenu(async () => "revision-after-save");
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "新建项目" }));
    expect(props.onNewProject).toHaveBeenCalledOnce();
    expect(props.onCanvasSync).not.toHaveBeenCalled();
    expect(mocks.exportAssets).not.toHaveBeenCalled();
  });

  it("does not export or restore when draft flush fails", async () => {
    renderMenu(async () => null);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /导出素材包/ }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.exportAssets).not.toHaveBeenCalled();

    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /恢复素材索引/ }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(2));
    expect(mocks.restoreAssets).not.toHaveBeenCalled();
    expect(props.onCanvasSync).not.toHaveBeenCalled();
  });

  it("restores using the flushed revision and waits for Canvas sync", async () => {
    const prepareCanvas = vi.fn(async () => "revision-after-save");
    renderMenu(prepareCanvas);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /恢复素材索引/ }));
    await waitFor(() =>
      expect(mocks.restoreAssets).toHaveBeenCalledWith(
        "token",
        "canvas-1",
        "revision-after-save",
      ),
    );
    await waitFor(() => expect(props.onCanvasSync).toHaveBeenCalledOnce());
  });
});
