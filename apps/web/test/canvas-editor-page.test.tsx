import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CanvasEditor } from "../src/components/canvas-editor";
import type { CanvasFilesPanelProps } from "../src/components/canvas-files-panel";
import type { CanvasToolMenu } from "../src/components/canvas-tool-menu";
import type { WebSocketHandle } from "../src/hooks/use-websocket";
import { ApiApplicationError } from "../src/lib/server-api";

const mocks = vi.hoisted(() => ({
  query: new URLSearchParams(),
  replace: vi.fn(),
  fetchCanvas: vi.fn(),
  fetchProject: vi.fn(),
  restoreAssets: vi.fn(),
  restoreOnEditorReady: false,
  restoreOperation: vi.fn(),
  assetOperationError: vi.fn(),
  prepareAssets: vi.fn(),
  applySnapshot: vi.fn(),
  handleSnapshot: vi.fn(),
  editorApiReady: false,
  toolRefresh: vi.fn(),
  editorMount: vi.fn(),
  editorUnmount: vi.fn(),
  editorRender: vi.fn(),
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  connected: false,
  onEvent: vi.fn(),
  onDocumentUpdated: vi.fn(),
  resumeCanvas: vi.fn(),
}));

vi.mock("next/navigation", () => {
  const router = { replace: mocks.replace };
  return { useSearchParams: () => mocks.query, useRouter: () => router };
});
vi.mock("../src/lib/server-api", () => ({
  ApiAccessError: class ApiAccessError extends Error {},
  ApiApplicationError: class ApiApplicationError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  fetchCanvas: mocks.fetchCanvas,
  fetchProject: mocks.fetchProject,
  restoreCanvasAssets: mocks.restoreAssets,
}));
vi.mock("../src/hooks/use-websocket", () => ({
  useWebSocket: () => ({
    startRun: mocks.startRun,
    cancelRun: mocks.cancelRun,
    connected: mocks.connected,
    onEvent: mocks.onEvent,
    onDocumentUpdated: mocks.onDocumentUpdated,
    resumeCanvas: mocks.resumeCanvas,
  }),
}));
vi.mock("@/lib/plugin-panels", () => ({ PluginPanelButtons: () => null }));
vi.mock("../src/components/canvas-editor", async () => {
  const { useEffect } = await import("react");
  return {
    CanvasEditor(props: Parameters<typeof CanvasEditor>[0]) {
      mocks.editorRender(props);
      useEffect(() => {
        mocks.editorMount(props.canvasId);
        props.onPrepareAssetOperation?.(mocks.prepareAssets);
        if (mocks.editorApiReady)
          props.onApiReady?.({} as ExcalidrawImperativeAPI);
        return () => {
          mocks.editorUnmount(props.canvasId);
        };
      }, [props.canvasId, props.onPrepareAssetOperation]);
      useEffect(() => {
        if (!props.remoteSnapshot) return;
        mocks.applySnapshot(props.remoteSnapshot);
        const revision = props.remoteSnapshot.revision;
        mocks.handleSnapshot(() => {
          props.onRevisionChanged?.(revision);
          props.onRemoteSnapshotHandled?.(revision);
        });
      }, [
        props.onRemoteSnapshotHandled,
        props.onRevisionChanged,
        props.remoteSnapshot,
      ]);
      return (
        <div data-testid="editor">
          <span>
            {props.canvasId}: {props.revision}
          </span>
          <button
            type="button"
            onClick={() =>
              props.onSelectionChange?.([
                {
                  id: "shape-a",
                  type: "rectangle",
                  x: 1,
                  y: 2,
                  width: 30,
                  height: 40,
                },
              ])
            }
          >
            选择图层
          </button>
          {props.overlay}
        </div>
      );
    },
  };
});
vi.mock("../src/components/canvas-inspector", async () => {
  const { useEffect } = await import("react");
  const restore = (operation: () => Promise<void>) => {
    const pending = operation();
    mocks.restoreOperation(pending);
    void pending.catch(mocks.assetOperationError);
  };
  return {
    CanvasInspector: ({ onRestoreAssets }: CanvasFilesPanelProps) => {
      useEffect(() => {
        if (!mocks.restoreOnEditorReady) return;
        mocks.restoreOnEditorReady = false;
        restore(onRestoreAssets);
      }, [onRestoreAssets]);
      return (
        <button type="button" onClick={() => restore(onRestoreAssets)}>
          恢复素材
        </button>
      );
    },
  };
});
vi.mock("../src/components/canvas-logo-menu", () => ({
  CanvasLogoMenu: ({
    onNewCanvas,
    onDeleteCanvas,
  }: {
    onNewCanvas: () => void;
    onDeleteCanvas: () => void;
  }) => (
    <>
      <button type="button" onClick={onNewCanvas}>
        新建画布
      </button>
      <button type="button" onClick={onDeleteCanvas}>
        删除画布
      </button>
    </>
  ),
}));
vi.mock("../src/components/canvas-tool-menu", () => ({
  CanvasToolMenu: ({ refresh }: Parameters<typeof CanvasToolMenu>[0]) => (
    <button type="button" onClick={() => mocks.toolRefresh(refresh())}>
      生成结果刷新
    </button>
  ),
}));
vi.mock("../src/components/brand-kit-modal", () => ({
  BrandKitModal: () => null,
}));
vi.mock("../src/components/brand-kit-selector", () => ({
  BrandKitSelector: ({
    onBrandKitChange,
  }: {
    onBrandKitChange: (id: string) => void;
  }) => (
    <button type="button" onClick={() => onBrandKitChange("brand-b")}>
      切换品牌
    </button>
  ),
}));
vi.mock("../src/components/editable-project-name", () => ({
  EditableProjectName: () => null,
}));
vi.mock("../src/components/loading-screen", () => ({
  LoadingScreen: () => <span>加载画布</span>,
}));

import CanvasPage from "../src/app/canvas/page";

function canvas(
  revision = "revision-1",
  id = "canvas-a",
  projectId = "project-a",
) {
  return {
    canvas: {
      id,
      projectId,
      name: "画布",
      revision,
      content: { elements: [], appState: {}, files: {} },
    },
  };
}
const origin = window.location.origin;
function refresh() {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source: window.parent,
      data: { type: "kenfutwork:canvas-refresh", canvasId: "canvas-a" },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connected = false;
  mocks.restoreOnEditorReady = false;
  mocks.editorApiReady = false;
  mocks.handleSnapshot.mockReset().mockImplementation((handled: () => void) => {
    handled();
  });
  mocks.onEvent.mockReset().mockReturnValue(() => {});
  mocks.onDocumentUpdated.mockReset().mockReturnValue(() => {});
  mocks.resumeCanvas.mockReset();
  mocks.query = new URLSearchParams("id=canvas-a&editor=1");
  mocks.fetchCanvas.mockReset().mockResolvedValue(canvas());
  mocks.fetchProject.mockReset().mockResolvedValue({
    project: { id: "project-a", name: "项目", brand_kit_id: "brand-a" },
  });
  mocks.prepareAssets.mockReset().mockResolvedValue("saved-revision");
  mocks.restoreAssets.mockReset().mockResolvedValue({ revision: "revision-2" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("直接画布链接进入共享工作台，旧prompt和session不触发Agent", async () => {
  mocks.query = new URLSearchParams("id=canvas-a&prompt=old&session=legacy");
  const view = render(<CanvasPage />);
  await waitFor(() =>
    expect(mocks.replace).toHaveBeenCalledWith(
      "/workbench?mode=design&projectId=project-a&canvasId=canvas-a",
    ),
  );
  expect(view.queryByTestId("editor")).toBeNull();
  expect(mocks.fetchProject).not.toHaveBeenCalled();
  expect(mocks.startRun).not.toHaveBeenCalled();
  expect(mocks.cancelRun).not.toHaveBeenCalled();
});

test("编辑器向共享宿主发真实选区、品牌与建/删画布动作", async () => {
  const post = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(() => {});
  mocks.query = new URLSearchParams(
    "id=canvas-a&editor=1&session=legacy&taskId=forged&prompt=old",
  );
  const view = render(<CanvasPage />);
  await view.findByTestId("editor");
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      {
        type: "kenfutwork:canvas-context",
        canvasId: "canvas-a",
        projectId: "project-a",
        selectedCanvasElements: [],
        brandKitId: "brand-a",
      },
      origin,
    ),
  );
  fireEvent.click(view.getByRole("button", { name: "选择图层" }));
  expect(post).toHaveBeenCalledWith(
    {
      type: "kenfutwork:canvas-context",
      canvasId: "canvas-a",
      projectId: "project-a",
      selectedCanvasElements: [
        { id: "shape-a", type: "rectangle", x: 1, y: 2, width: 30, height: 40 },
      ],
      brandKitId: "brand-a",
    },
    origin,
  );
  fireEvent.click(view.getByRole("button", { name: "切换品牌" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "kenfutwork:canvas-context",
        brandKitId: "brand-b",
      }),
      origin,
    ),
  );
  fireEvent.click(view.getByRole("button", { name: "新建画布" }));
  expect(post).toHaveBeenCalledWith(
    {
      type: "kenfutwork:canvas-create",
      canvasId: "canvas-a",
      projectId: "project-a",
    },
    origin,
  );
  fireEvent.click(view.getByRole("button", { name: "删除画布" }));
  expect(post).toHaveBeenCalledWith(
    {
      type: "kenfutwork:canvas-delete",
      canvasId: "canvas-a",
      projectId: "project-a",
    },
    origin,
  );
  expect(mocks.startRun).not.toHaveBeenCalled();
  expect(mocks.cancelRun).not.toHaveBeenCalled();
});

test("重放刷新只应用一次最新快照，编辑器不重挂且不发Run", async () => {
  const post = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(() => {});
  mocks.fetchCanvas
    .mockResolvedValueOnce(canvas())
    .mockResolvedValue(canvas("revision-2"));
  const view = render(<CanvasPage />);
  await view.findByTestId("editor");
  // 父effect先安装消息接收器再发布上下文；编辑器DOM出现不能证明这条订阅已就绪。
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      {
        type: "kenfutwork:canvas-context",
        canvasId: "canvas-a",
        projectId: "project-a",
        selectedCanvasElements: [],
        brandKitId: "brand-a",
      },
      origin,
    ),
  );
  await act(async () => {
    refresh();
    refresh();
    refresh();
  });
  await waitFor(() => expect(mocks.fetchCanvas).toHaveBeenCalledTimes(3));
  expect(mocks.applySnapshot).toHaveBeenCalledOnce();
  expect(mocks.applySnapshot).toHaveBeenCalledWith({
    revision: "revision-2",
    content: canvas().canvas.content,
  });
  expect(mocks.editorMount).toHaveBeenCalledOnce();
  expect(mocks.editorUnmount).not.toHaveBeenCalled();
  expect(mocks.startRun).not.toHaveBeenCalled();
  expect(view.getByTestId("editor").textContent).toContain("revision-2");
});

test("生成器和WS并发刷新同一revision，快照回执后两路继续完成", async () => {
  mocks.connected = true;
  mocks.editorApiReady = true;
  mocks.handleSnapshot.mockImplementation(() => {});
  mocks.fetchCanvas
    .mockResolvedValueOnce(canvas())
    .mockResolvedValue(canvas("revision-2"));
  const view = render(<CanvasPage />);
  const tool = await view.findByRole("button", { name: "生成结果刷新" });
  await waitFor(() => expect(mocks.onEvent).toHaveBeenCalledOnce());
  const listener: Parameters<WebSocketHandle["onEvent"]>[0] =
    mocks.onEvent.mock.calls[0]?.[0];

  await act(async () => {
    fireEvent.click(tool);
    listener({
      type: "canvas.sync",
      runId: "run-a",
      timestamp: new Date().toISOString(),
    });
  });
  await waitFor(() => expect(mocks.applySnapshot).toHaveBeenCalledOnce());
  const toolFinished = vi.fn();
  const toolRefresh: Promise<void> = mocks.toolRefresh.mock.calls[0]?.[0];
  void toolRefresh.then(toolFinished);
  expect(toolFinished).not.toHaveBeenCalled();

  await act(async () => {
    const handled: () => void = mocks.handleSnapshot.mock.calls[0]?.[0];
    handled();
  });
  await waitFor(() => expect(toolFinished).toHaveBeenCalledOnce());
  expect(view.getByTestId("editor").textContent).toContain("revision-2");

  mocks.handleSnapshot.mockImplementation((handled: () => void) => handled());
  mocks.fetchCanvas.mockResolvedValue(canvas("revision-3"));
  await act(async () => {
    listener({
      type: "canvas.sync",
      runId: "run-b",
      timestamp: new Date().toISOString(),
    });
  });
  await waitFor(() =>
    expect(view.getByTestId("editor").textContent).toContain("revision-3"),
  );
  expect(mocks.editorMount).toHaveBeenCalledOnce();
  expect(mocks.startRun).not.toHaveBeenCalled();
});

test("并发刷新等待快照期间卸载，生成器等待结束且排队通知不再读取", async () => {
  mocks.connected = true;
  mocks.editorApiReady = true;
  mocks.handleSnapshot.mockImplementation(() => {});
  mocks.fetchCanvas
    .mockResolvedValueOnce(canvas())
    .mockResolvedValue(canvas("revision-2"));
  const view = render(<CanvasPage />);
  const tool = await view.findByRole("button", { name: "生成结果刷新" });
  await waitFor(() => expect(mocks.onEvent).toHaveBeenCalledOnce());
  const listener: Parameters<WebSocketHandle["onEvent"]>[0] =
    mocks.onEvent.mock.calls[0]?.[0];
  await act(async () => {
    fireEvent.click(tool);
    listener({
      type: "canvas.sync",
      runId: "run-a",
      timestamp: new Date().toISOString(),
    });
  });
  await waitFor(() => expect(mocks.applySnapshot).toHaveBeenCalledOnce());
  const finished = vi.fn();
  const toolRefresh: Promise<void> = mocks.toolRefresh.mock.calls[0]?.[0];
  void toolRefresh.then(finished);
  const reads = mocks.fetchCanvas.mock.calls.length;

  view.unmount();
  await waitFor(() => expect(finished).toHaveBeenCalledOnce());
  expect(mocks.fetchCanvas).toHaveBeenCalledTimes(reads);
  expect(mocks.editorUnmount).toHaveBeenCalledOnce();
});

test("生成器刷新GET迟到前切文档，旧等待结束且不把旧快照交给新编辑器", async () => {
  let completeRefresh = (_value: ReturnType<typeof canvas>) => {};
  mocks.connected = true;
  mocks.editorApiReady = true;
  mocks.fetchCanvas.mockResolvedValueOnce(canvas()).mockImplementationOnce(
    () =>
      new Promise<ReturnType<typeof canvas>>((resolve) => {
        completeRefresh = resolve;
      }),
  );
  const view = render(<CanvasPage />);
  const tool = await view.findByRole("button", { name: "生成结果刷新" });
  await waitFor(() => expect(mocks.onEvent).toHaveBeenCalledOnce());
  const listener: Parameters<WebSocketHandle["onEvent"]>[0] =
    mocks.onEvent.mock.calls[0]?.[0];
  await act(async () => {
    fireEvent.click(tool);
    listener({
      type: "canvas.sync",
      runId: "run-a",
      timestamp: new Date().toISOString(),
    });
  });
  const finished = vi.fn();
  const toolRefresh: Promise<void> = mocks.toolRefresh.mock.calls[0]?.[0];
  void toolRefresh.then(finished);
  mocks.query = new URLSearchParams("id=canvas-b&editor=1");
  mocks.fetchCanvas.mockResolvedValue(
    canvas("revision-b", "canvas-b", "project-b"),
  );
  view.rerender(<CanvasPage />);
  await waitFor(() =>
    expect(view.getByTestId("editor").textContent).toContain("canvas-b"),
  );
  const reads = mocks.fetchCanvas.mock.calls.length;

  await act(async () => completeRefresh(canvas("revision-2")));
  await waitFor(() => expect(finished).toHaveBeenCalledOnce());
  expect(mocks.applySnapshot).not.toHaveBeenCalled();
  expect(mocks.fetchCanvas).toHaveBeenCalledTimes(reads);
  expect(view.getByTestId("editor").textContent).toContain("revision-b");
});

test("切文档后旧编辑器保存回执不能覆盖新revision或干扰素材恢复与刷新", async () => {
  mocks.editorApiReady = true;
  const view = render(<CanvasPage />);
  await view.findByTestId("editor");
  const oldEditor: Parameters<typeof CanvasEditor>[0] =
    mocks.editorRender.mock.calls.at(-1)?.[0];

  mocks.query = new URLSearchParams("id=canvas-b&editor=1");
  mocks.fetchCanvas.mockResolvedValue(
    canvas("revision-b", "canvas-b", "project-b"),
  );
  mocks.prepareAssets.mockResolvedValue("saved-revision-b");
  view.rerender(<CanvasPage />);
  await waitFor(() =>
    expect(view.getByTestId("editor").textContent).toContain(
      "canvas-b: revision-b",
    ),
  );

  await act(async () => oldEditor.onRevisionChanged?.("old-saved-revision"));
  expect(view.getByTestId("editor").textContent).toContain(
    "canvas-b: revision-b",
  );
  fireEvent.click(view.getByRole("button", { name: "生成结果刷新" }));
  await act(async () => {
    const pending: Promise<void> = mocks.toolRefresh.mock.calls[0]?.[0];
    await pending;
  });
  fireEvent.click(view.getByRole("button", { name: "恢复素材" }));
  await waitFor(() =>
    expect(mocks.restoreAssets).toHaveBeenCalledWith(
      null,
      "canvas-b",
      "saved-revision-b",
    ),
  );
  expect(mocks.prepareAssets).toHaveBeenCalledOnce();
  expect(mocks.applySnapshot).not.toHaveBeenCalled();
  expect(mocks.assetOperationError).not.toHaveBeenCalled();
});

test("跨文档相同revision的旧快照回执不能提前确认新画布刷新", async () => {
  mocks.editorApiReady = true;
  mocks.handleSnapshot.mockImplementation(() => {});
  mocks.fetchCanvas
    .mockResolvedValueOnce(canvas())
    .mockResolvedValueOnce(canvas("shared-revision"));
  const view = render(<CanvasPage />);
  fireEvent.click(await view.findByRole("button", { name: "生成结果刷新" }));
  await waitFor(() => expect(mocks.applySnapshot).toHaveBeenCalledOnce());
  const oldEditor: Parameters<typeof CanvasEditor>[0] =
    mocks.editorRender.mock.calls.at(-1)?.[0];

  mocks.query = new URLSearchParams("id=canvas-b&editor=1");
  mocks.fetchCanvas.mockResolvedValue(
    canvas("revision-b", "canvas-b", "project-b"),
  );
  view.rerender(<CanvasPage />);
  await waitFor(() =>
    expect(view.getByTestId("editor").textContent).toContain("canvas-b"),
  );
  expect(mocks.applySnapshot).toHaveBeenCalledOnce();
  mocks.fetchCanvas.mockResolvedValue(
    canvas("shared-revision", "canvas-b", "project-b"),
  );
  const snapshotsBeforeRefresh = mocks.applySnapshot.mock.calls.length;
  fireEvent.click(view.getByRole("button", { name: "生成结果刷新" }));
  await waitFor(() => {
    expect(mocks.applySnapshot).toHaveBeenCalledTimes(
      snapshotsBeforeRefresh + 1,
    );
    const editor: Parameters<typeof CanvasEditor>[0] =
      mocks.editorRender.mock.calls.at(-1)?.[0];
    expect(editor.canvasId).toBe("canvas-b");
    expect(editor.remoteSnapshot?.revision).toBe("shared-revision");
    expect(mocks.toolRefresh).toHaveBeenCalledTimes(2);
  });
  const finished = vi.fn();
  const pending: Promise<void> = mocks.toolRefresh.mock.calls[1]?.[0];
  void pending.then(finished);

  await act(async () => oldEditor.onRemoteSnapshotHandled?.("shared-revision"));
  expect(finished).not.toHaveBeenCalled();
  const editor: Parameters<typeof CanvasEditor>[0] =
    mocks.editorRender.mock.calls.at(-1)?.[0];
  expect(editor.remoteSnapshot?.revision).toBe("shared-revision");
  expect(view.getByTestId("editor").textContent).toContain(
    "canvas-b: revision-b",
  );

  await act(async () => {
    editor.onRevisionChanged?.("shared-revision");
    editor.onRemoteSnapshotHandled?.("shared-revision");
    await pending;
  });
  expect(finished).toHaveBeenCalledOnce();
  expect(view.getByTestId("editor").textContent).toContain(
    "canvas-b: shared-revision",
  );
});

test("素材恢复先等待保存再用真实revision恢复，最后走同一快照链", async () => {
  let completeSave = (_revision: string) => {};
  mocks.prepareAssets.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        completeSave = resolve;
      }),
  );
  // 子effect注册后立即操作：不能依赖父级另一次state提交才拿到保存入口。
  mocks.restoreOnEditorReady = true;
  mocks.fetchCanvas
    .mockResolvedValueOnce(canvas())
    .mockResolvedValue(canvas("revision-2"));
  const view = render(<CanvasPage />);
  await view.findByTestId("editor");
  await waitFor(() => expect(mocks.prepareAssets).toHaveBeenCalledOnce());
  expect(mocks.restoreAssets).not.toHaveBeenCalled();
  expect(mocks.fetchCanvas).toHaveBeenCalledOnce();
  expect(mocks.applySnapshot).not.toHaveBeenCalled();
  completeSave("saved-revision");
  await waitFor(() => expect(mocks.applySnapshot).toHaveBeenCalledOnce());
  expect(mocks.restoreAssets).toHaveBeenCalledWith(
    null,
    "canvas-a",
    "saved-revision",
  );
  expect(mocks.prepareAssets.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.restoreAssets.mock.invocationCallOrder[0]!,
  );
  expect(mocks.restoreAssets.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.fetchCanvas.mock.invocationCallOrder[1]!,
  );
  expect(mocks.editorMount).toHaveBeenCalledOnce();
  expect(mocks.assetOperationError).not.toHaveBeenCalled();
});

test("素材保存未取得revision时不恢复、不刷新，保留失败", async () => {
  mocks.prepareAssets.mockResolvedValueOnce(null);
  mocks.restoreOnEditorReady = true;
  const view = render(<CanvasPage />);
  await view.findByTestId("editor");
  await waitFor(() => expect(mocks.assetOperationError).toHaveBeenCalledOnce());
  expect(mocks.assetOperationError.mock.calls[0]?.[0]).toMatchObject({
    message: "画布保存失败，未恢复素材",
  });
  expect(mocks.prepareAssets).toHaveBeenCalledOnce();
  expect(mocks.restoreAssets).not.toHaveBeenCalled();
  expect(mocks.fetchCanvas).toHaveBeenCalledOnce();
  expect(mocks.applySnapshot).not.toHaveBeenCalled();
});

test("素材保存等待期间切文档，旧revision不能恢复新文档或触发旧刷新", async () => {
  let completeSave = (_revision: string) => {};
  mocks.prepareAssets.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        completeSave = resolve;
      }),
  );
  mocks.restoreOnEditorReady = true;
  const view = render(<CanvasPage />);
  await waitFor(() => expect(mocks.prepareAssets).toHaveBeenCalledOnce());
  mocks.query = new URLSearchParams("id=canvas-b&editor=1");
  mocks.fetchCanvas.mockResolvedValue(
    canvas("revision-b", "canvas-b", "project-b"),
  );
  view.rerender(<CanvasPage />);
  await waitFor(() =>
    expect(view.getByTestId("editor").textContent).toContain("canvas-b"),
  );
  completeSave("old-saved-revision");
  await waitFor(() => expect(mocks.assetOperationError).toHaveBeenCalledOnce());
  expect(mocks.restoreAssets).not.toHaveBeenCalled();
  expect(mocks.fetchCanvas).toHaveBeenCalledTimes(2);
  expect(mocks.applySnapshot).not.toHaveBeenCalled();
});

test("切换文档时旧加载结果不覆盖新编辑器或发布旧上下文", async () => {
  let resolveOld = (_value: ReturnType<typeof canvas>) => {};
  mocks.fetchCanvas.mockImplementationOnce(
    () =>
      new Promise<ReturnType<typeof canvas>>((resolve) => {
        resolveOld = resolve;
      }),
  );
  const post = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(() => {});
  const view = render(<CanvasPage />);
  mocks.query = new URLSearchParams("id=canvas-b&editor=1");
  mocks.fetchCanvas.mockResolvedValue(
    canvas("revision-b", "canvas-b", "project-b"),
  );
  view.rerender(<CanvasPage />);
  await view.findByTestId("editor");
  resolveOld(canvas());
  await waitFor(() =>
    expect(view.getByTestId("editor").textContent).toContain("canvas-b"),
  );
  expect(
    post.mock.calls.some(([message]) => message.canvasId === "canvas-a"),
  ).toBe(false);
  expect(mocks.editorMount).toHaveBeenCalledWith("canvas-b");
  expect(mocks.editorMount).not.toHaveBeenCalledWith("canvas-a");
});

test("真实WS先监听再resume，ACK和重连GET补放，重复canvas.sync只对账", async () => {
  const release = vi.fn();
  mocks.connected = true;
  mocks.onEvent.mockReturnValue(release);
  mocks.resumeCanvas.mockImplementation(
    (id: string, ack: Parameters<WebSocketHandle["resumeCanvas"]>[1]) =>
      ack?.({
        type: "command.ack",
        action: "canvas.resume",
        payload: { canvasId: id },
      }),
  );
  const view = render(<CanvasPage />);
  await waitFor(() =>
    expect(mocks.resumeCanvas).toHaveBeenCalledWith(
      "canvas-a",
      expect.any(Function),
    ),
  );
  expect(mocks.onEvent.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.resumeCanvas.mock.invocationCallOrder[0]!,
  );
  await waitFor(() => expect(mocks.fetchCanvas).toHaveBeenCalledTimes(2));
  const listener: Parameters<WebSocketHandle["onEvent"]>[0] =
    mocks.onEvent.mock.calls[0]?.[0];
  mocks.fetchCanvas.mockResolvedValue(canvas("revision-2"));
  await act(async () => {
    listener({
      type: "canvas.sync",
      runId: "run-a",
      timestamp: new Date().toISOString(),
    });
    listener({
      type: "canvas.sync",
      runId: "run-a",
      timestamp: new Date().toISOString(),
    });
  });
  await waitFor(() => expect(mocks.applySnapshot).toHaveBeenCalledOnce());
  mocks.connected = false;
  view.rerender(<CanvasPage />);
  expect(release).toHaveBeenCalledOnce();
  mocks.connected = true;
  view.rerender(<CanvasPage />);
  await waitFor(() => expect(mocks.resumeCanvas).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mocks.fetchCanvas).toHaveBeenCalledTimes(5));
  expect(mocks.applySnapshot).toHaveBeenCalledOnce();
  expect(mocks.startRun).not.toHaveBeenCalled();
});

test("旧文档WS回执和推送迟到不刷新新文档", async () => {
  mocks.connected = true;
  const view = render(<CanvasPage />);
  await waitFor(() => expect(mocks.resumeCanvas).toHaveBeenCalledOnce());
  const oldListener: Parameters<WebSocketHandle["onEvent"]>[0] =
    mocks.onEvent.mock.calls[0]?.[0];
  const oldAck: NonNullable<Parameters<WebSocketHandle["resumeCanvas"]>[1]> =
    mocks.resumeCanvas.mock.calls[0]?.[1];
  mocks.query = new URLSearchParams("id=canvas-b&editor=1");
  mocks.fetchCanvas.mockResolvedValue(
    canvas("revision-b", "canvas-b", "project-b"),
  );
  view.rerender(<CanvasPage />);
  await waitFor(() => expect(mocks.resumeCanvas).toHaveBeenCalledTimes(2));
  const reads = mocks.fetchCanvas.mock.calls.length;
  await act(async () => {
    oldListener({
      type: "canvas.sync",
      runId: "old-run",
      timestamp: new Date().toISOString(),
    });
    oldAck({
      type: "command.ack",
      action: "canvas.resume",
      payload: { canvasId: "canvas-a" },
    });
  });
  expect(mocks.fetchCanvas).toHaveBeenCalledTimes(reads);
  expect(view.getByTestId("editor").textContent).toContain("canvas-b");
});

test.each([
  { status: "rejected", canvasId: "canvas-a", message: "没有画布权限" },
  { canvasId: "different-canvas" },
])(
  "画布订阅拒绝或目标不匹配时显示错误，不刷新或启动Agent：%j",
  async (payload) => {
    mocks.connected = true;
    mocks.resumeCanvas.mockImplementation(
      (_id: string, ack: Parameters<WebSocketHandle["resumeCanvas"]>[1]) =>
        ack?.({ type: "command.ack", action: "canvas.resume", payload }),
    );
    const view = render(<CanvasPage />);
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toBe(
        "画布订阅失败，请重新打开",
      ),
    );
    expect(view.getByTestId("editor").textContent).toContain("canvas-a");
    expect(mocks.fetchCanvas).toHaveBeenCalledOnce();
    expect(mocks.startRun).not.toHaveBeenCalled();
  },
);

test("文档变更独立通知按真实画布和项目对账，重复通知不重复应用内容", async () => {
  mocks.connected = true;
  const post = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(() => {});
  const view = render(<CanvasPage />);
  await view.findByTestId("editor");
  await waitFor(() => expect(mocks.onDocumentUpdated).toHaveBeenCalledOnce());
  const changed: Parameters<WebSocketHandle["onDocumentUpdated"]>[0] =
    mocks.onDocumentUpdated.mock.calls[0]?.[0];
  const message = {
    type: "canvas.document.updated" as const,
    canvasId: "canvas-a",
    projectId: "project-a",
    revision: "a".repeat(64),
    deleted: false,
  };
  await act(async () => {
    changed({ ...message, canvasId: "canvas-b" });
    changed({ ...message, projectId: "project-b" });
  });
  expect(mocks.fetchCanvas).toHaveBeenCalledOnce();
  mocks.fetchCanvas.mockResolvedValue(canvas(message.revision));
  await act(async () => {
    changed(message);
    changed(message);
  });
  await waitFor(() => expect(mocks.applySnapshot).toHaveBeenCalledOnce());
  expect(post).toHaveBeenCalledWith(
    {
      type: "kenfutwork:canvas-document-updated",
      canvasId: "canvas-a",
      projectId: "project-a",
      revision: message.revision,
      deleted: false,
    },
    origin,
  );
  expect(mocks.startRun).not.toHaveBeenCalled();
  expect(view.getByTestId("editor").textContent).toContain("canvas-a");
});

test("真实删除通知移除编辑器并通知宿主，删除后的迟到变更不重新读取", async () => {
  mocks.connected = true;
  const release = vi.fn();
  mocks.onDocumentUpdated.mockReturnValue(release);
  const post = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(() => {});
  const view = render(<CanvasPage />);
  await view.findByTestId("editor");
  await waitFor(() => expect(mocks.onDocumentUpdated).toHaveBeenCalledOnce());
  const changed: Parameters<WebSocketHandle["onDocumentUpdated"]>[0] =
    mocks.onDocumentUpdated.mock.calls[0]?.[0];
  const message = {
    type: "canvas.document.updated" as const,
    canvasId: "canvas-a",
    projectId: "project-a",
    deleted: true,
  };
  // 删除回调还会触发WS effect清理；等本次派发的effect结算再检查release。
  await act(async () => changed(message));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toBe(
      "画布已删除，请选择其他画布",
    ),
  );
  expect(view.queryByTestId("editor")).toBeNull();
  expect(release).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledWith(
    {
      type: "kenfutwork:canvas-document-updated",
      canvasId: "canvas-a",
      projectId: "project-a",
      deleted: true,
    },
    origin,
  );
  await act(async () => changed({ ...message, deleted: false }));
  expect(mocks.fetchCanvas).toHaveBeenCalledOnce();
  expect(mocks.startRun).not.toHaveBeenCalled();
});

test("断线时删除画布，恢复ACK后的权威404清理旧编辑器与宿主引用", async () => {
  const post = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(() => {});
  const view = render(<CanvasPage />);
  await view.findByTestId("editor");
  mocks.fetchCanvas.mockRejectedValue(
    new ApiApplicationError("canvas_not_found", "画布不存在"),
  );
  mocks.resumeCanvas.mockImplementation(
    (id: string, ack: Parameters<WebSocketHandle["resumeCanvas"]>[1]) =>
      ack?.({
        type: "command.ack",
        action: "canvas.resume",
        payload: { canvasId: id },
      }),
  );
  mocks.connected = true;
  view.rerender(<CanvasPage />);
  await waitFor(() => expect(view.queryByTestId("editor")).toBeNull());
  expect(view.getByRole("alert").textContent).toBe(
    "画布已删除，请选择其他画布",
  );
  expect(post).toHaveBeenCalledWith(
    {
      type: "kenfutwork:canvas-document-updated",
      canvasId: "canvas-a",
      projectId: "project-a",
      deleted: true,
    },
    origin,
  );
  const count = mocks.fetchCanvas.mock.calls.length;
  const late: Parameters<WebSocketHandle["onDocumentUpdated"]>[0] =
    mocks.onDocumentUpdated.mock.calls.at(-1)?.[0];
  await act(async () => {
    late({
      type: "canvas.document.updated",
      canvasId: "canvas-a",
      projectId: "project-a",
      deleted: false,
    });
  });
  expect(mocks.fetchCanvas).toHaveBeenCalledTimes(count);
});
