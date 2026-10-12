import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addFiles: vi.fn(),
  elements: [] as Array<Record<string, unknown>>,
  files: {} as Record<string, Record<string, unknown>>,
  onChange: null as null | ((elements: unknown[], appState: unknown) => void),
  saveCanvas: vi.fn(),
  serverFetch: vi.fn(),
  updateScene: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));
vi.mock("@/lib/local-access", () => ({ serverFetch: mocks.serverFetch }));
vi.mock("@/lib/server-api", () => ({
  saveCanvas: mocks.saveCanvas,
  uploadThumbnail: vi.fn(),
}));
vi.mock("@/lib/canvas-elements", () => ({ isVideoUrl: () => false }));
vi.mock("./canvas-stats-panel", () => ({ CanvasStatsPanel: () => null }));
vi.mock("./canvas/video-canvas-element", () => ({
  VideoCanvasElement: () => null,
}));
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: () =>
      function MockExcalidraw(props: {
        initialData: {
          elements: Array<Record<string, unknown>>;
          files: Record<string, Record<string, unknown>>;
        };
        onChange: (elements: unknown[], appState: unknown) => void;
        excalidrawAPI: (api: unknown) => void;
      }) {
        const initialized = React.useRef(false);
        const api = React.useMemo(
          () => ({
            addFiles: mocks.addFiles,
            getAppState: () => ({
              viewBackgroundColor: "#fff",
              gridModeEnabled: false,
            }),
            getFiles: () => mocks.files,
            getSceneElements: () => mocks.elements,
            updateScene: mocks.updateScene,
          }),
          [],
        );
        React.useEffect(() => {
          if (!initialized.current) {
            mocks.elements = props.initialData.elements;
            mocks.files = props.initialData.files;
            initialized.current = true;
          }
          props.excalidrawAPI(api);
        }, [api, props.excalidrawAPI, props.initialData]);
        mocks.onChange = props.onChange;
        return React.createElement(
          "button",
          {
            "data-testid": "mock-excalidraw",
            onClick: () =>
              mocks.onChange?.(mocks.elements, {
                selectedElementIds: {},
                viewBackgroundColor: "#fff",
                gridModeEnabled: false,
              }),
            type: "button",
          },
          "Canvas",
        );
      },
  };
});

import type { CanvasContent, CanvasSaveResponse } from "@kenfutwork/shared";
import { CanvasEditor } from "../src/components/canvas-editor";

const baseElement = {
  id: "element-1",
  type: "rectangle",
  x: 0,
  y: 0,
  width: 20,
  height: 20,
};
const baseContent: CanvasContent = {
  elements: [baseElement],
  appState: {},
  files: {},
};

function editorProps(
  overrides: Partial<ComponentProps<typeof CanvasEditor>> = {},
) {
  return {
    canvasId: "canvas-1",
    projectId: "project-1",
    revision: "revision-1",
    accessToken: null,
    initialContent: baseContent,
    ...overrides,
  };
}

async function finishHydration() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

describe("CanvasEditor remote snapshot sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.addFiles.mockReset();
    mocks.updateScene.mockReset();
    mocks.elements = [baseElement];
    mocks.files = {};
    mocks.onChange = null;
    mocks.saveCanvas.mockReset().mockResolvedValue({
      ok: true,
      revision: "revision-2",
      fileReferences: {},
    } satisfies CanvasSaveResponse);
    mocks.serverFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("adopts a pristine remote revision and uses it for the next save", async () => {
    const view = render(<CanvasEditor {...editorProps()} />);
    await finishHydration();
    mocks.updateScene.mockClear();

    view.rerender(
      <CanvasEditor
        {...editorProps({
          remoteSnapshot: {
            revision: "revision-remote",
            content: {
              ...baseContent,
              elements: [{ ...baseElement, id: "remote-element" }],
            },
          },
        })}
      />,
    );
    await act(async () => {});

    expect(mocks.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [expect.objectContaining({ id: "remote-element" })],
      }),
    );
    mocks.elements = [{ ...baseElement, id: "local-after-remote" }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(mocks.saveCanvas).toHaveBeenCalledWith(
      null,
      "canvas-1",
      expect.objectContaining({
        elements: [expect.objectContaining({ id: "local-after-remote" })],
      }),
      "revision-remote",
    );
  });

  it("keeps a dirty local draft and does not apply the remote scene", async () => {
    const view = render(<CanvasEditor {...editorProps()} />);
    await finishHydration();
    mocks.updateScene.mockClear();
    mocks.elements = [{ ...baseElement, id: "local-draft" }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));

    view.rerender(
      <CanvasEditor
        {...editorProps({
          remoteSnapshot: {
            revision: "revision-remote",
            content: {
              ...baseContent,
              elements: [{ ...baseElement, id: "remote-element" }],
            },
          },
        })}
      />,
    );
    await act(async () => {});

    expect(mocks.updateScene).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("当前草稿已保留");
    expect(mocks.elements).toEqual([
      expect.objectContaining({ id: "local-draft" }),
    ]);
  });

  it("flushes the current draft and exposes the new CAS revision for asset operations", async () => {
    let prepare: (() => Promise<string | null>) | undefined;
    const onRevisionChanged = vi.fn();
    const view = render(
      <CanvasEditor
        {...editorProps({
          onRevisionChanged,
          onPrepareAssetOperation: (fn) => {
            prepare = fn;
          },
        })}
      />,
    );
    await finishHydration();
    mocks.elements = [{ ...baseElement, id: "asset-operation-draft" }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));

    let revision: string | null = null;
    await act(async () => {
      revision = (await prepare?.()) ?? null;
    });

    expect(revision).toBe("revision-2");
    expect(mocks.saveCanvas).toHaveBeenCalledWith(
      null,
      "canvas-1",
      expect.objectContaining({
        elements: [expect.objectContaining({ id: "asset-operation-draft" })],
      }),
      "revision-1",
    );
    expect(onRevisionChanged).toHaveBeenCalledWith("revision-2");
    view.unmount();
  });

  it("does not expose a revision for asset operations after a save conflict", async () => {
    mocks.saveCanvas.mockRejectedValue(
      Object.assign(
        new Error(
          "画布已在其他位置更新，当前草稿已保留。请复制草稿后重新加载。",
        ),
        { code: "canvas_revision_conflict" },
      ),
    );
    let prepare: (() => Promise<string | null>) | undefined;
    render(
      <CanvasEditor
        {...editorProps({
          onPrepareAssetOperation: (fn) => {
            prepare = fn;
          },
        })}
      />,
    );
    await finishHydration();
    mocks.elements = [{ ...baseElement, id: "conflicted-draft" }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));

    let revision: string | null = "stale";
    await act(async () => {
      revision = (await prepare?.()) ?? null;
    });
    expect(revision).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("当前草稿已保留");
  });

  it("retains a known stable file reference while storage hydration is pending", async () => {
    let finishFetch: ((response: Response) => void) | undefined;
    mocks.serverFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        finishFetch = resolve;
      }),
    );
    const fileContent: CanvasContent = {
      ...baseContent,
      files: {
        image: {
          id: "image",
          mimeType: "image/png",
          created: 1,
          storageRef: "oss://stable-image",
          storageUrl: "https://signed.test/image",
          dataURL: "data:image/png;base64,old-browser-bytes",
        },
      },
    };
    render(<CanvasEditor {...editorProps({ initialContent: fileContent })} />);
    await finishHydration();
    mocks.elements = [{ ...baseElement, id: "local-draft" }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    const savedContent = mocks.saveCanvas.mock.calls[0]?.[2] as CanvasContent;
    expect(savedContent.files.image).toMatchObject({
      storageRef: "oss://stable-image",
    });
    expect(savedContent.files.image).not.toHaveProperty("dataURL");
    expect(finishFetch).toBeDefined();
  });
});
