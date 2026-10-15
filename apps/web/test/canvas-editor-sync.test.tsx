import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";
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
  appState: {
    viewBackgroundColor: "#fff",
    gridModeEnabled: false,
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    selectedElementIds: {} as Record<string, boolean>,
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));
vi.mock("@/lib/local-access", () => ({ serverFetch: mocks.serverFetch }));
vi.mock("@/lib/server-api", () => ({
  saveCanvas: mocks.saveCanvas,
  uploadThumbnail: vi.fn(),
}));
vi.mock("./canvas-stats-panel", () => ({ CanvasStatsPanel: () => null }));
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
        renderEmbeddable: NonNullable<ExcalidrawProps["renderEmbeddable"]>;
      }) {
        const initialized = React.useRef(false);
        const api = React.useMemo(
          () => ({
            addFiles: mocks.addFiles,
            getAppState: () => mocks.appState,
            getFiles: () => mocks.files,
            getSceneElements: () => mocks.elements,
            getSceneElementsIncludingDeleted: () => mocks.elements,
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
          React.Fragment,
          null,
          React.createElement(
            "button",
            {
              "data-testid": "mock-excalidraw",
              onClick: () => mocks.onChange?.(mocks.elements, mocks.appState),
              type: "button",
            },
            "Canvas",
          ),
          ...props.initialData.elements
            .filter((element) => element.type === "embeddable")
            .map((element) => {
              // The third-party canvas receives the persisted opaque scene here.
              const rendered = props.renderEmbeddable(
                element as unknown as Parameters<
                  typeof props.renderEmbeddable
                >[0],
                mocks.appState as Parameters<typeof props.renderEmbeddable>[1],
              );
              return React.createElement(
                "div",
                { key: String(element.id) },
                rendered ??
                  React.createElement("div", {
                    "data-testid": "default-embeddable",
                  }),
              );
            }),
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
    mocks.addFiles
      .mockReset()
      .mockImplementation((files: Array<Record<string, unknown>>) => {
        for (const file of files) {
          if (typeof file.id === "string") mocks.files[file.id] = file;
        }
      });
    mocks.updateScene.mockReset();
    mocks.appState = {
      viewBackgroundColor: "#fff",
      gridModeEnabled: false,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
      selectedElementIds: {},
    };
    mocks.updateScene.mockImplementation(
      (update: {
        elements?: Array<Record<string, unknown>>;
        appState?: Partial<typeof mocks.appState>;
      }) => {
        if (update.elements) mocks.elements = update.elements;
        if (update.appState)
          mocks.appState = { ...mocks.appState, ...update.appState };
        mocks.onChange?.(mocks.elements, mocks.appState);
      },
    );
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

  it.each([
    {
      name: "signed video link without a file extension",
      link: "https://media.test/api/blobs/video-output?expires=123&signature=abc",
      customData: { isVideo: true, mimeType: "video/mp4" },
      video: true,
    },
    {
      name: "legacy mp4 link",
      link: "https://media.test/output.mp4?signature=abc",
      customData: {},
      video: true,
    },
    {
      name: "ordinary web link",
      link: "https://example.test/article",
      customData: {},
      video: false,
    },
    {
      name: "video metadata without a link",
      link: null,
      customData: { isVideo: true, mimeType: "video/mp4" },
      video: false,
    },
  ])("renders $name through the correct canvas player", async (fixture) => {
    const view = render(
      <CanvasEditor
        {...editorProps({
          initialContent: {
            ...baseContent,
            elements: [
              {
                ...baseElement,
                type: "embeddable",
                width: 640,
                height: 360,
                link: fixture.link,
                customData: fixture.customData,
              },
            ],
          },
        })}
      />,
    );
    await finishHydration();

    if (fixture.video) {
      const player = screen.getByRole("button", { name: "播放视频" });
      expect(player.querySelector("video")?.getAttribute("src")).toBe(
        fixture.link,
      );
      expect(screen.queryByTestId("default-embeddable")).toBeNull();
    } else {
      expect(screen.queryByRole("button", { name: "播放视频" })).toBeNull();
      expect(view.container.querySelector("video")).toBeNull();
      expect(screen.getByTestId("default-embeddable")).not.toBeNull();
    }
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

  it("applies a snapshot received before editor hydration finishes", async () => {
    render(
      <CanvasEditor
        {...editorProps({
          remoteSnapshot: {
            revision: "revision-early",
            content: {
              ...baseContent,
              elements: [{ ...baseElement, id: "early-remote" }],
            },
          },
        })}
      />,
    );
    await finishHydration();
    await act(async () => {});
    expect(mocks.elements).toEqual([
      expect.objectContaining({ id: "early-remote" }),
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["auto", "manual", "unmount"])(
    "persists an explicit deletion of every element through %s save",
    async (method) => {
      const view = render(<CanvasEditor {...editorProps()} />);
      await finishHydration();
      mocks.elements = [{ ...baseElement, isDeleted: true, version: 2 }];
      fireEvent.click(screen.getByTestId("mock-excalidraw"));
      if (method === "auto") {
        await act(async () => vi.advanceTimersByTimeAsync(1500));
      } else if (method === "manual") {
        await act(async () => {
          fireEvent.keyDown(window, { key: "s", ctrlKey: true });
        });
      } else {
        view.unmount();
        await act(async () => {});
      }
      expect(mocks.saveCanvas).toHaveBeenCalledWith(
        null,
        "canvas-1",
        expect.objectContaining({ elements: [] }),
        "revision-1",
      );
    },
  );

  it("keeps a dirty local draft and does not apply the remote scene", async () => {
    const view = render(<CanvasEditor {...editorProps()} />);
    await finishHydration();
    mocks.updateScene.mockClear();
    mocks.elements = [{ ...baseElement, x: 25 }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));

    view.rerender(
      <CanvasEditor
        {...editorProps({
          remoteSnapshot: {
            revision: "revision-remote",
            content: {
              ...baseContent,
              elements: [{ ...baseElement, x: 40 }],
            },
          },
        })}
      />,
    );
    await act(async () => {});

    expect(mocks.updateScene).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("当前草稿已保留");
    expect(mocks.elements).toEqual([
      expect.objectContaining({ id: "element-1", x: 25 }),
    ]);
  });

  it("merges an unsaved local move with a remote generated image and saves both against the remote revision", async () => {
    const selection = vi.fn();
    const initialContent = {
      ...baseContent,
      appState: { viewBackgroundColor: "#fff", gridModeEnabled: false },
    };
    const image = {
      id: "generated-image",
      type: "image",
      fileId: "generated-file",
      x: 80,
      y: 0,
      width: 40,
      height: 40,
    };
    const imageFile = {
      id: "generated-file",
      dataURL: "data:image/png;base64,generated",
      mimeType: "image/png",
      created: 1,
      storageRef: "oss://generated-file",
    };
    const view = render(
      <CanvasEditor
        {...editorProps({ initialContent, onSelectionChange: selection })}
      />,
    );
    await finishHydration();
    mocks.updateScene.mockClear();
    mocks.elements = [{ ...baseElement, x: 25 }];
    mocks.appState = {
      ...mocks.appState,
      scrollX: -123,
      scrollY: 45,
      zoom: { value: 0.5 },
      selectedElementIds: { "element-1": true },
    };
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    expect(mocks.saveCanvas).not.toHaveBeenCalled();

    view.rerender(
      <CanvasEditor
        {...editorProps({
          initialContent,
          onSelectionChange: selection,
          remoteSnapshot: {
            revision: "revision-generated",
            content: {
              elements: [baseElement, image],
              appState: {
                viewBackgroundColor: "#eee",
                gridModeEnabled: false,
                scrollX: 900,
                selectedElementIds: { "generated-image": true },
              },
              files: { "generated-file": imageFile },
            },
          },
        })}
      />,
    );
    await act(async () => {});

    expect(mocks.elements).toEqual([{ ...baseElement, x: 25 }, image]);
    expect(mocks.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({ captureUpdate: "NEVER" }),
    );
    expect(mocks.addFiles).toHaveBeenCalledWith([
      expect.objectContaining({ id: "generated-file" }),
    ]);
    expect(mocks.appState).toMatchObject({
      viewBackgroundColor: "#eee",
      scrollX: -123,
      scrollY: 45,
      zoom: { value: 0.5 },
      selectedElementIds: { "element-1": true },
    });
    expect(selection).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "element-1", x: 25 }),
    ]);
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(mocks.saveCanvas).toHaveBeenCalledWith(
      null,
      "canvas-1",
      expect.objectContaining({
        elements: [{ ...baseElement, x: 25 }, image],
        appState: { viewBackgroundColor: "#eee", gridModeEnabled: false },
        files: {
          "generated-file": expect.objectContaining({
            storageRef: "oss://generated-file",
          }),
        },
      }),
      "revision-generated",
    );
  });

  it.each([0, 2000])(
    "keeps edits made while a remote image downloads and saves the latest move with the image (%i ms download)",
    async (downloadWaitMs) => {
      type ImageResponse = { ok: true; blob: () => Promise<Blob> };
      let completeDownload = (_response: ImageResponse) => {};
      mocks.serverFetch.mockImplementationOnce(
        () =>
          new Promise<ImageResponse>((resolve) => {
            completeDownload = resolve;
          }),
      );
      const image = {
        id: "generated-image",
        type: "image",
        fileId: "generated-file",
        x: 80,
        y: 0,
        width: 40,
        height: 40,
      };
      const handled = vi.fn();
      const view = render(
        <CanvasEditor {...editorProps({ onRemoteSnapshotHandled: handled })} />,
      );
      await finishHydration();
      mocks.elements = [{ ...baseElement, x: 25 }];
      fireEvent.click(screen.getByTestId("mock-excalidraw"));
      view.rerender(
        <CanvasEditor
          {...editorProps({
            onRemoteSnapshotHandled: handled,
            remoteSnapshot: {
              revision: "revision-generated",
              content: {
                ...baseContent,
                elements: [baseElement, image],
                files: {
                  "generated-file": {
                    id: "generated-file",
                    mimeType: "image/png",
                    created: 1,
                    storageRef: "oss://generated-file",
                    storageUrl: "https://signed.test/generated-image",
                  },
                },
              },
            },
          })}
        />,
      );
      await act(async () => {});
      expect(mocks.serverFetch).toHaveBeenCalledWith(
        "https://signed.test/generated-image",
      );
      expect(handled).not.toHaveBeenCalled();
      mocks.elements = [{ ...baseElement, x: 30 }];
      fireEvent.click(screen.getByTestId("mock-excalidraw"));
      expect(mocks.saveCanvas).not.toHaveBeenCalled();
      if (downloadWaitMs > 0) {
        await act(async () => vi.advanceTimersByTimeAsync(downloadWaitMs));
        expect(mocks.saveCanvas).not.toHaveBeenCalled();
      }

      await act(async () => {
        completeDownload({
          ok: true,
          blob: async () =>
            new Blob(["generated-image"], { type: "image/png" }),
        });
        await vi.advanceTimersByTimeAsync(5);
      });
      expect(handled).toHaveBeenCalledWith("revision-generated");
      expect(mocks.elements).toEqual([{ ...baseElement, x: 30 }, image]);
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(mocks.saveCanvas).toHaveBeenCalledWith(
        null,
        "canvas-1",
        expect.objectContaining({
          elements: [{ ...baseElement, x: 30 }, image],
        }),
        "revision-generated",
      );
    },
  );

  it("does not revive a remote deletion while saving an independent local move", async () => {
    const second = { ...baseElement, id: "element-2" };
    const initialContent = { ...baseContent, elements: [baseElement, second] };
    const view = render(<CanvasEditor {...editorProps({ initialContent })} />);
    await finishHydration();
    mocks.elements = [baseElement, { ...second, x: 25 }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));

    view.rerender(
      <CanvasEditor
        {...editorProps({
          initialContent,
          remoteSnapshot: {
            revision: "revision-deleted",
            content: { ...initialContent, elements: [second] },
          },
        })}
      />,
    );
    await act(async () => {});
    expect(mocks.elements).toEqual([{ ...second, x: 25 }]);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(mocks.saveCanvas).toHaveBeenCalledWith(
      null,
      "canvas-1",
      expect.objectContaining({ elements: [{ ...second, x: 25 }] }),
      "revision-deleted",
    );
  });

  it("preserves an explicit local empty-scene deletion across a remote setting update", async () => {
    const view = render(<CanvasEditor {...editorProps()} />);
    await finishHydration();
    mocks.elements = [{ ...baseElement, isDeleted: true, version: 2 }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));

    view.rerender(
      <CanvasEditor
        {...editorProps({
          remoteSnapshot: {
            revision: "revision-background",
            content: {
              ...baseContent,
              appState: { viewBackgroundColor: "#eee" },
            },
          },
        })}
      />,
    );
    await act(async () => {});
    expect(mocks.elements).toEqual([
      { ...baseElement, isDeleted: true, version: 2 },
    ]);
    expect(mocks.appState.viewBackgroundColor).toBe("#eee");
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(mocks.saveCanvas).toHaveBeenCalledWith(
      null,
      "canvas-1",
      expect.objectContaining({ elements: [] }),
      "revision-background",
    );
  });

  it("retains the draft and blocks saving when both sides change the same document setting", async () => {
    const view = render(<CanvasEditor {...editorProps()} />);
    await finishHydration();
    mocks.updateScene.mockClear();
    mocks.appState = { ...mocks.appState, viewBackgroundColor: "#000" };
    fireEvent.click(screen.getByTestId("mock-excalidraw"));

    view.rerender(
      <CanvasEditor
        {...editorProps({
          remoteSnapshot: {
            revision: "revision-conflicting-background",
            content: {
              ...baseContent,
              appState: { viewBackgroundColor: "#eee" },
            },
          },
        })}
      />,
    );
    await act(async () => {});
    expect(mocks.updateScene).not.toHaveBeenCalled();
    expect(mocks.appState.viewBackgroundColor).toBe("#000");
    expect(screen.getByRole("alert").textContent).toContain("当前草稿已保留");
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
  });

  it("adopts remote content after viewport and selection changes while preserving both", async () => {
    const selection = vi.fn();
    const view = render(
      <CanvasEditor {...editorProps({ onSelectionChange: selection })} />,
    );
    await finishHydration();
    mocks.updateScene.mockClear();
    mocks.appState = {
      ...mocks.appState,
      scrollX: -123,
      scrollY: 45,
      zoom: { value: 0.5 },
      selectedElementIds: { "element-1": true },
    };
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    view.rerender(
      <CanvasEditor
        {...editorProps({
          onSelectionChange: selection,
          remoteSnapshot: {
            revision: "revision-remote",
            content: { ...baseContent, elements: [{ ...baseElement, x: 40 }] },
          },
        })}
      />,
    );
    await act(async () => {});
    expect(mocks.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [expect.objectContaining({ id: "element-1", x: 40 })],
      }),
    );
    expect(mocks.appState).toMatchObject({
      scrollX: -123,
      scrollY: 45,
      zoom: { value: 0.5 },
      selectedElementIds: { "element-1": true },
    });
    expect(selection).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "element-1", x: 40 }),
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("acknowledges the saved scene so later remote changes can continue", async () => {
    const view = render(<CanvasEditor {...editorProps()} />);
    await finishHydration();
    mocks.elements = [{ ...baseElement, id: "saved-local" }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(mocks.saveCanvas).toHaveBeenCalledOnce();
    mocks.updateScene.mockClear();
    view.rerender(
      <CanvasEditor
        {...editorProps({
          remoteSnapshot: {
            revision: "revision-after-save",
            content: {
              ...baseContent,
              elements: [{ ...baseElement, id: "remote-later" }],
            },
          },
        })}
      />,
    );
    await act(async () => {});
    expect(mocks.elements).toEqual([
      expect.objectContaining({ id: "remote-later" }),
    ]);
    expect(mocks.updateScene).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("waits for the in-flight save before applying a later remote revision", async () => {
    let completeSave: ((value: CanvasSaveResponse) => void) | undefined;
    mocks.saveCanvas.mockImplementationOnce(
      () =>
        new Promise<CanvasSaveResponse>((resolve) => {
          completeSave = resolve;
        }),
    );
    const view = render(<CanvasEditor {...editorProps()} />);
    await finishHydration();
    mocks.elements = [{ ...baseElement, id: "saving-local" }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    mocks.updateScene.mockClear();
    view.rerender(
      <CanvasEditor
        {...editorProps({
          remoteSnapshot: {
            revision: "revision-after-save",
            content: {
              ...baseContent,
              elements: [{ ...baseElement, id: "remote-later" }],
            },
          },
        })}
      />,
    );
    await act(async () => {});
    expect(mocks.updateScene).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      completeSave?.({ ok: true, revision: "revision-2", fileReferences: {} });
    });
    expect(mocks.elements).toEqual([
      expect.objectContaining({ id: "remote-later" }),
    ]);
    expect(mocks.updateScene).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not acknowledge edits made after a save was submitted", async () => {
    let completeSave: ((value: CanvasSaveResponse) => void) | undefined;
    mocks.saveCanvas.mockImplementationOnce(
      () =>
        new Promise<CanvasSaveResponse>((resolve) => {
          completeSave = resolve;
        }),
    );
    const view = render(<CanvasEditor {...editorProps()} />);
    await finishHydration();
    mocks.elements = [{ ...baseElement, x: 10 }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    mocks.elements = [{ ...baseElement, x: 20 }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await act(async () => {
      completeSave?.({ ok: true, revision: "revision-2", fileReferences: {} });
    });
    mocks.updateScene.mockClear();
    view.rerender(
      <CanvasEditor
        {...editorProps({
          remoteSnapshot: {
            revision: "revision-after-save",
            content: { ...baseContent, elements: [{ ...baseElement, x: 40 }] },
          },
        })}
      />,
    );
    await act(async () => {});
    expect(mocks.updateScene).not.toHaveBeenCalled();
    expect(mocks.elements).toEqual([
      expect.objectContaining({ id: "element-1", x: 20 }),
    ]);
    expect(screen.getByRole("alert").textContent).toContain("当前草稿已保留");
    expect(mocks.saveCanvas.mock.calls[0]?.[2].elements).toEqual([
      expect.objectContaining({ id: "element-1", x: 10 }),
    ]);
  });

  it("ignores a replay of a known old revision without rolling back the saved scene", async () => {
    const handled = vi.fn();
    const view = render(
      <CanvasEditor {...editorProps({ onRemoteSnapshotHandled: handled })} />,
    );
    await finishHydration();
    mocks.elements = [{ ...baseElement, id: "saved-local" }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    mocks.updateScene.mockClear();
    view.rerender(
      <CanvasEditor
        {...editorProps({
          onRemoteSnapshotHandled: handled,
          remoteSnapshot: { revision: "revision-1", content: baseContent },
        })}
      />,
    );
    await act(async () => {});
    expect(mocks.updateScene).not.toHaveBeenCalled();
    expect(mocks.elements).toEqual([
      expect.objectContaining({ id: "saved-local" }),
    ]);
    expect(handled).toHaveBeenCalledWith("revision-1");
    expect(screen.queryByRole("alert")).toBeNull();
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
