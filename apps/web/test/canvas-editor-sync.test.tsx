import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { IDBDatabase as FakeIDBDatabase, IDBFactory } from "fake-indexeddb";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRealRestoreElements } from "./setup/real-excalidraw-restore";

const mocks = vi.hoisted(() => ({
  addFiles: vi.fn(),
  elements: [] as Array<Record<string, unknown>>,
  restoreInitialElements: null as
    | null
    | ((
        elements: Array<Record<string, unknown>>,
      ) => Array<Record<string, unknown>>),
  files: {} as Record<string, Record<string, unknown>>,
  onChange: null as null | ((elements: unknown[], appState: unknown) => void),
  saveCanvas: vi.fn(),
  triggerDownload: vi.fn(),
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
vi.mock("@/lib/download", () => ({ triggerDownload: mocks.triggerDownload }));
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
        viewModeEnabled: boolean;
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
            mocks.elements = mocks.restoreInitialElements
              ? mocks.restoreInitialElements(props.initialData.elements)
              : props.initialData.elements;
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
              disabled: props.viewModeEnabled,
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
import { createCanvasFileStore } from "../../server/src/features/canvas/file-store";
import { CanvasEditor } from "../src/components/canvas-editor";
import { createCanvasDraftStore } from "../src/lib/canvas-draft-store";
import { canvasSceneKey } from "../src/lib/canvas-scene-state";

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

/** 真实事务照常提交，只延迟下一笔写事务交给调用者的完成事件。 */
function delayNextDraftCompletion() {
  let intercepted = false;
  let release = () => {};
  let captured = () => {};
  const pending = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const original = FakeIDBDatabase.prototype.transaction;
  const spy = vi
    .spyOn(FakeIDBDatabase.prototype, "transaction")
    .mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const transaction = original.call(this, names, mode, options);
      if (mode === "readwrite" && !intercepted) {
        intercepted = true;
        transaction.addEventListener(
          "complete",
          (event) => {
            event.stopImmediatePropagation();
            release = () => {
              spy.mockRestore();
              transaction.oncomplete?.call(transaction, event);
            };
            captured();
          },
          { once: true },
        );
      }
      return transaction;
    });
  return { captured: pending, release: () => release() };
}

describe("CanvasEditor remote snapshot sync", () => {
  const temporaryRoots: string[] = [];
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
    mocks.restoreInitialElements = null;
    mocks.files = {};
    mocks.onChange = null;
    mocks.saveCanvas.mockReset().mockResolvedValue({
      ok: true,
      revision: "revision-2",
      fileReferences: {},
    } satisfies CanvasSaveResponse);
    mocks.serverFetch.mockReset();
    mocks.triggerDownload.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("restores a durable unconfirmed draft after reopening without saving an initialization frame", async () => {
    vi.useRealTimers();
    vi.stubGlobal("indexedDB", new IDBFactory());
    const store = createCanvasDraftStore();
    const image = {
      ...baseElement,
      id: "unsaved-image",
      type: "image",
      fileId: "unsaved-image-file",
    };
    const draft: CanvasContent = {
      elements: [{ ...baseElement, x: 25 }, image],
      appState: { viewBackgroundColor: "#123456", gridModeEnabled: true },
      files: {
        "unsaved-image-file": {
          id: "unsaved-image-file",
          mimeType: "image/png",
          created: 1,
          dataURL: "data:image/png;base64,unsaved-image-bytes",
        },
      },
    };
    await store.write(
      { projectId: "project-1", canvasId: "canvas-1", clientId: "closed-tab" },
      {
        generation: 1,
        content: draft,
        base: { revision: "revision-1", content: baseContent },
        submitted: {
          revision: "revision-1",
          sceneKey: canvasSceneKey(draft),
        },
      },
    );
    await store.close();

    render(<CanvasEditor {...editorProps()} />);
    // IDB 相关验收保留真实调度，按编辑器结果等待，避免混用两套时钟。
    await waitFor(() => {
      expect(mocks.elements).toEqual(draft.elements);
    });

    expect(mocks.elements).toEqual(draft.elements);
    expect(mocks.appState).toMatchObject(draft.appState);
    expect(mocks.files).toMatchObject(draft.files);
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.saveCanvas).toHaveBeenCalledWith(
        null,
        "canvas-1",
        expect.objectContaining(draft),
        "revision-1",
      ),
    );
  });

  it("restores a local reversal when an in-flight save reached the server before the editor closed", async () => {
    vi.useRealTimers();
    vi.stubGlobal("indexedDB", new IDBFactory());
    const store = createCanvasDraftStore();
    const submitted = {
      ...baseContent,
      elements: [{ ...baseElement, x: 10 }],
    };
    await store.write(
      { projectId: "project-1", canvasId: "canvas-1", clientId: "closed-tab" },
      {
        generation: 3,
        content: baseContent,
        base: { revision: "revision-1", content: baseContent },
        submitted: {
          revision: "revision-1",
          sceneKey: canvasSceneKey(submitted),
        },
      },
    );
    await store.close();

    render(
      <CanvasEditor
        {...editorProps({ revision: "revision-2", initialContent: submitted })}
      />,
    );
    await waitFor(() => {
      expect(mocks.elements).toEqual(baseContent.elements);
    });
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.saveCanvas).toHaveBeenCalledWith(
        null,
        "canvas-1",
        expect.objectContaining({ elements: baseContent.elements }),
        "revision-2",
      ),
    );
  });

  it("keeps a newer local reversal durable after an older save acknowledgement and reopening", async () => {
    vi.useRealTimers();
    vi.stubGlobal("indexedDB", new IDBFactory());
    let completeSave: ((value: CanvasSaveResponse) => void) | undefined;
    mocks.saveCanvas.mockImplementationOnce(
      () =>
        new Promise<CanvasSaveResponse>((resolve) => {
          completeSave = resolve;
        }),
    );
    const view = render(<CanvasEditor {...editorProps()} />);
    await waitFor(() => {
      expect(
        (screen.getByTestId("mock-excalidraw") as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    mocks.elements = [{ ...baseElement, x: 10 }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await waitFor(() => expect(mocks.saveCanvas).toHaveBeenCalledOnce());
    mocks.elements = [baseElement];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await act(async () => {
      completeSave?.({ ok: true, revision: "revision-2", fileReferences: {} });
    });

    const store = createCanvasDraftStore();
    await waitFor(async () => {
      const saved = await store.list({
        projectId: "project-1",
        canvasId: "canvas-1",
      });
      expect(saved).toHaveLength(1);
      expect(saved[0]?.content.elements).toEqual([baseElement]);
      expect(saved[0]?.base.content.elements).toEqual([
        { ...baseElement, x: 10 },
      ]);
      expect(saved[0]?.base.revision).toBe("revision-2");
      expect(saved[0]?.submitted).toBeNull();
    });
    mocks.saveCanvas.mockRejectedValue(new Error("offline"));
    await act(async () => {
      view.unmount();
      await store.list({ projectId: "project-1", canvasId: "canvas-1" });
    });
    render(
      <CanvasEditor
        {...editorProps({
          revision: "revision-2",
          initialContent: {
            ...baseContent,
            elements: [{ ...baseElement, x: 10 }],
          },
        })}
      />,
    );
    await waitFor(() => {
      expect(
        (screen.getByTestId("mock-excalidraw") as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(mocks.elements).toEqual([baseElement]);
    });
    await store.close();
  });

  it("recovers a reversal after an unknown network result and a same-revision retry lose the race to the old request", async () => {
    vi.useRealTimers();
    vi.stubGlobal("indexedDB", new IDBFactory());
    const original = {
      ...baseContent,
      appState: { viewBackgroundColor: "#fff", gridModeEnabled: false },
    };
    const older = { ...original, elements: [{ ...baseElement, x: 10 }] };
    let serverContent = original;
    let serverRevision = "revision-1";
    let rejectUnknown: ((error: Error) => void) | undefined;
    mocks.saveCanvas.mockImplementation(
      (_token, _canvasId, content, expectedRevision) => {
        if (mocks.saveCanvas.mock.calls.length === 1)
          return new Promise<CanvasSaveResponse>((_resolve, reject) => {
            rejectUnknown = reject;
          });
        if (mocks.saveCanvas.mock.calls.length === 2) {
          // 请求已离开客户端，但网络失败没有说明服务端是否提交；它在重试前才抵达。
          serverContent = older;
          serverRevision = "old-request-revision-2";
        }
        if (expectedRevision !== serverRevision)
          return Promise.reject(
            Object.assign(new Error("stale canvas revision"), {
              code: "canvas_revision_conflict",
            }),
          );
        serverContent = content;
        serverRevision = "recovered-revision-3";
        return Promise.resolve({
          ok: true,
          revision: serverRevision,
          fileReferences: {},
        });
      },
    );
    const view = render(
      <CanvasEditor {...editorProps({ initialContent: original })} />,
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("mock-excalidraw") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    mocks.elements = older.elements;
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await waitFor(() => expect(mocks.saveCanvas).toHaveBeenCalledOnce());
    mocks.elements = [baseElement];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await act(async () => rejectUnknown?.(new Error("network result unknown")));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "stale canvas revision",
      ),
    );
    expect(mocks.saveCanvas.mock.calls.map((call) => call[3])).toEqual([
      "revision-1",
      "revision-1",
    ]);
    expect(serverContent.elements).toEqual(older.elements);
    const store = createCanvasDraftStore();
    await act(async () => {
      view.unmount();
      await store.list({ projectId: "project-1", canvasId: "canvas-1" });
    });
    render(
      <CanvasEditor
        {...editorProps({
          initialContent: serverContent,
          revision: serverRevision,
        })}
      />,
    );
    await waitFor(() => {
      expect(
        (screen.getByTestId("mock-excalidraw") as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(mocks.elements).toEqual([baseElement]);
    });
    await store.close();
  });

  it("keeps the newer remote baseline when an old save's IndexedDB completion arrives after a remote adoption and local edit", async () => {
    vi.useRealTimers();
    vi.stubGlobal("indexedDB", new IDBFactory());
    const initial = {
      ...baseContent,
      appState: { viewBackgroundColor: "#fff", gridModeEnabled: false },
    };
    const remote = { ...initial, elements: [{ ...baseElement, x: 20 }] };
    const view = render(
      <CanvasEditor {...editorProps({ initialContent: initial })} />,
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("mock-excalidraw") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    mocks.elements = [{ ...baseElement, x: 10 }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    const inspector = createCanvasDraftStore();
    await waitFor(async () =>
      expect(
        (
          await inspector.list({ projectId: "project-1", canvasId: "canvas-1" })
        )[0]?.content.elements,
      ).toEqual([{ ...baseElement, x: 10 }]),
    );
    const delayed = delayNextDraftCompletion();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await delayed.captured;
    await waitFor(() => expect(mocks.saveCanvas).toHaveBeenCalledOnce());
    view.rerender(
      <CanvasEditor
        {...editorProps({
          initialContent: initial,
          remoteSnapshot: { revision: "remote-revision-3", content: remote },
        })}
      />,
    );
    await waitFor(() => expect(mocks.elements).toEqual(remote.elements));
    mocks.elements = [{ ...baseElement, x: 25 }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    await act(async () => {
      delayed.release();
      // 完成事件的 Promise 回调全部入队后，以公开读取事务等待其写入完成。
      await nextEventLoop();
      await inspector.list({ projectId: "project-1", canvasId: "canvas-1" });
    });
    const drafts = await inspector.list({
      projectId: "project-1",
      canvasId: "canvas-1",
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.content.elements).toEqual([{ ...baseElement, x: 25 }]);
    expect(drafts[0]?.base.revision).toBe("remote-revision-3");
    expect(drafts[0]?.base.content.elements).toEqual(remote.elements);
    mocks.saveCanvas.mockRejectedValue(new Error("offline"));
    await act(async () => {
      view.unmount();
      await nextEventLoop();
      await inspector.list({ projectId: "project-1", canvasId: "canvas-1" });
    });
    render(
      <CanvasEditor
        {...editorProps({
          initialContent: remote,
          revision: "remote-revision-3",
        })}
      />,
    );
    await waitFor(() => {
      expect(
        (screen.getByTestId("mock-excalidraw") as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(mocks.elements).toEqual([{ ...baseElement, x: 25 }]);
      expect(screen.queryByRole("alert")).toBeNull();
    });
    await inspector.close();
  });

  it("acknowledges an already confirmed recovered draft so a later remote revision does not resurrect a ghost conflict", async () => {
    vi.useRealTimers();
    vi.stubGlobal("indexedDB", new IDBFactory());
    const initial = {
      ...baseContent,
      appState: { viewBackgroundColor: "#fff", gridModeEnabled: false },
    };
    const confirmed = { ...initial, elements: [{ ...baseElement, x: 25 }] };
    const later = { ...initial, elements: [{ ...baseElement, x: 35 }] };
    const store = createCanvasDraftStore();
    await store.write(
      { projectId: "project-1", canvasId: "canvas-1", clientId: "closed-tab" },
      {
        generation: 2,
        content: confirmed,
        base: {
          revision: "revision-1",
          content: initial,
          localContent: initial,
        },
        submitted: {
          revision: "revision-1",
          sceneKey: canvasSceneKey(confirmed),
        },
      },
    );
    const view = render(
      <CanvasEditor
        {...editorProps({
          initialContent: confirmed,
          revision: "confirmed-revision-2",
        })}
      />,
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("mock-excalidraw") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    view.rerender(
      <CanvasEditor
        {...editorProps({
          initialContent: confirmed,
          revision: "confirmed-revision-2",
          remoteSnapshot: { revision: "later-revision-3", content: later },
        })}
      />,
    );
    await waitFor(() => expect(mocks.elements).toEqual(later.elements));
    view.unmount();
    render(
      <CanvasEditor
        {...editorProps({
          initialContent: later,
          revision: "later-revision-3",
        })}
      />,
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("mock-excalidraw") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.elements).toEqual(later.elements);
    expect(
      await store.list({ projectId: "project-1", canvasId: "canvas-1" }),
    ).toEqual([]);
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    await store.close();
  });

  it.each([false, true])(
    "fences a still in-flight older save before it can replace an equal restored reversal (empty: %s)",
    async (empty) => {
      vi.useRealTimers();
      vi.stubGlobal("indexedDB", new IDBFactory());
      const store = createCanvasDraftStore();
      const original = {
        ...baseContent,
        elements: empty ? [] : [baseElement],
        appState: { viewBackgroundColor: "#fff", gridModeEnabled: false },
      };
      const submitted = { ...original, elements: [{ ...baseElement, x: 10 }] };
      const projectRoot = await mkdtemp(join(tmpdir(), "kfw-editor-cas-"));
      temporaryRoots.push(projectRoot);
      const canvasFiles = createCanvasFileStore({ projectRoot });
      const initial = await canvasFiles.save("canvas-1", original, null);
      const lateOldRequest = () =>
        canvasFiles.save("canvas-1", submitted, initial.revision);
      mocks.saveCanvas.mockImplementation(
        async (_token, canvasId, content, expectedRevision) => {
          const saved = await canvasFiles.save(
            canvasId,
            content,
            expectedRevision,
          );
          return { ok: true, revision: saved.revision, fileReferences: {} };
        },
      );
      await store.write(
        {
          projectId: "project-1",
          canvasId: "canvas-1",
          clientId: "closed-tab",
        },
        {
          generation: 3,
          content: original,
          base: {
            revision: initial.revision,
            content: original,
            localContent: original,
          },
          submitted: {
            revision: initial.revision,
            sceneKey: canvasSceneKey(submitted),
          },
        },
      );
      await store.close();
      render(
        <CanvasEditor
          {...editorProps({
            initialContent: original,
            revision: initial.revision,
          })}
        />,
      );
      await waitFor(() =>
        expect(mocks.saveCanvas).toHaveBeenCalledWith(
          null,
          "canvas-1",
          expect.objectContaining({ elements: original.elements }),
          initial.revision,
        ),
      );
      await expect(lateOldRequest()).rejects.toMatchObject({
        code: "revision_conflict",
        statusCode: 409,
      });
      const current = await canvasFiles.read("canvas-1");
      expect(current?.content.elements).toEqual(original.elements);
      expect(current?.revision).not.toBe(initial.revision);
    },
  );

  it("preserves conflicting client drafts separately and exports each original without choosing a winner", async () => {
    vi.useRealTimers();
    vi.stubGlobal("indexedDB", new IDBFactory());
    const store = createCanvasDraftStore();
    const originals = [25, 35].map((x) => ({
      ...baseContent,
      elements: [{ ...baseElement, x }],
    }));
    for (const [index, content] of originals.entries()) {
      await store.write(
        {
          projectId: "project-1",
          canvasId: "canvas-1",
          clientId: `closed-tab-${index}`,
        },
        {
          generation: 1,
          content,
          base: { revision: "revision-1", content: baseContent },
          submitted: null,
        },
      );
    }
    render(<CanvasEditor {...editorProps()} />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "本地草稿存在冲突",
      );
    });
    expect(mocks.elements).toEqual([baseElement]);
    fireEvent.click(screen.getByRole("button", { name: "导出草稿 1" }));
    fireEvent.click(screen.getByRole("button", { name: "导出草稿 2" }));
    expect(mocks.triggerDownload.mock.calls.map((call) => call[0])).toEqual([
      "画布草稿-1.excalidraw",
      "画布草稿-2.excalidraw",
    ]);
    for (const [index, call] of mocks.triggerDownload.mock.calls.entries()) {
      const exported = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsText(call[1]);
      });
      expect(JSON.parse(exported)).toMatchObject({
        type: "excalidraw",
        ...originals[index],
      });
    }
    expect(
      (await store.list({ projectId: "project-1", canvasId: "canvas-1" })).map(
        (draft) => draft.content,
      ),
    ).toEqual(originals);
    expect(mocks.saveCanvas).not.toHaveBeenCalled();
    await store.close();
  });

  it("reports unavailable local durability while allowing an explicit server save", async () => {
    vi.stubGlobal("indexedDB", undefined);
    render(<CanvasEditor {...editorProps()} />);
    await finishHydration();
    expect(screen.getByRole("status").textContent).toContain("本地草稿不可用");
    mocks.elements = [{ ...baseElement, x: 25 }];
    fireEvent.click(screen.getByTestId("mock-excalidraw"));
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await act(async () => {});
    expect(mocks.saveCanvas).toHaveBeenCalledWith(
      null,
      "canvas-1",
      expect.objectContaining({ elements: [{ ...baseElement, x: 25 }] }),
      "revision-1",
    );
    expect(
      screen
        .getAllByRole("status")
        .some((status) => status.textContent?.includes("本地草稿未保存")),
    ).toBe(true);
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

  it.each([true, false])(
    "reconciles real restoreElements hydration with sparse remote content (local move: %s)",
    async (moveLocal) => {
      const restoreElements = await loadRealRestoreElements();
      mocks.restoreInitialElements = (elements) =>
        restoreElements(
          elements as unknown as Parameters<typeof restoreElements>[0],
          null,
        );
      const selection = vi.fn();
      const view = render(
        <CanvasEditor {...editorProps({ onSelectionChange: selection })} />,
      );
      await finishHydration();
      const hydrated = mocks.elements[0]!;
      expect(hydrated).toMatchObject({ isDeleted: false, seed: 1 });
      expect(hydrated.version).toBeGreaterThanOrEqual(1);
      expect(hydrated.index).toEqual(expect.any(String));
      expect(hydrated.updated).toEqual(expect.any(Number));
      expect(baseElement).not.toHaveProperty("version");
      const local = moveLocal
        ? {
            ...hydrated,
            x: 25,
            version: Number(hydrated.version) + 1,
            versionNonce: 123,
            updated: Date.now() + 1,
          }
        : hydrated;
      mocks.elements = [local];
      mocks.appState = {
        ...mocks.appState,
        scrollX: -123,
        scrollY: 45,
        zoom: { value: 0.5 },
        selectedElementIds: { "element-1": true },
      };
      fireEvent.click(screen.getByTestId("mock-excalidraw"));
      const result = {
        ...baseElement,
        id: "remote-result",
        type: "ellipse",
        x: 80,
      };
      view.rerender(
        <CanvasEditor
          {...editorProps({
            onSelectionChange: selection,
            remoteSnapshot: {
              revision: "revision-sparse-result",
              content: { ...baseContent, elements: [baseElement, result] },
            },
          })}
        />,
      );
      await act(async () => {});

      expect(mocks.elements).toEqual([local, result]);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(mocks.appState).toMatchObject({
        scrollX: -123,
        scrollY: 45,
        zoom: { value: 0.5 },
        selectedElementIds: { "element-1": true },
      });
      expect(selection).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: "element-1", x: moveLocal ? 25 : 0 }),
      ]);
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      if (moveLocal) {
        expect(mocks.saveCanvas).toHaveBeenCalledWith(
          null,
          "canvas-1",
          expect.objectContaining({ elements: [local, result] }),
          "revision-sparse-result",
        );
      } else expect(mocks.saveCanvas).not.toHaveBeenCalled();
    },
  );

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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextEventLoop } from "node:timers/promises";
