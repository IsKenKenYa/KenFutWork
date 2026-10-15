import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CanvasEditor } from "../src/components/canvas-editor";
import type { CanvasFilesPanelProps } from "../src/components/canvas-files-panel";
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
  editorMount: vi.fn(),
  editorUnmount: vi.fn(),
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
      useEffect(() => {
        mocks.editorMount(props.canvasId);
        props.onPrepareAssetOperation?.(mocks.prepareAssets);
        return () => {
          mocks.editorUnmount(props.canvasId);
        };
      }, [props.canvasId, props.onPrepareAssetOperation]);
      useEffect(() => {
        if (!props.remoteSnapshot) return;
        mocks.applySnapshot(props.remoteSnapshot);
        props.onRevisionChanged?.(props.remoteSnapshot.revision);
        props.onRemoteSnapshotHandled?.(props.remoteSnapshot.revision);
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
vi.mock("../src/components/canvas-empty-hint", () => ({
  CanvasEmptyHint: ({ onOpenChat }: { onOpenChat: () => void }) => (
    <button type="button" onClick={onOpenChat}>
      聚焦会话
    </button>
  ),
}));
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
  CanvasLogoMenu: ({ onNewProject }: { onNewProject: () => void }) => (
    <button type="button" onClick={onNewProject}>
      新建项目
    </button>
  ),
}));
vi.mock("../src/components/canvas-tool-menu", () => ({
  CanvasToolMenu: () => null,
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

test("编辑器向共享宿主发真实选区、品牌、焦点和项目动作", async () => {
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
  fireEvent.click(view.getByRole("button", { name: "聚焦会话" }));
  expect(post).toHaveBeenCalledWith(
    {
      type: "kenfutwork:canvas-focus-session",
      canvasId: "canvas-a",
      projectId: "project-a",
    },
    origin,
  );
  fireEvent.click(view.getByRole("button", { name: "新建项目" }));
  expect(post).toHaveBeenCalledWith(
    {
      type: "kenfutwork:canvas-new-project",
      canvasId: "canvas-a",
      projectId: "project-a",
    },
    origin,
  );
  expect(mocks.startRun).not.toHaveBeenCalled();
  expect(mocks.cancelRun).not.toHaveBeenCalled();
});

test("重放刷新只应用一次最新快照，编辑器不重挂且不发Run", async () => {
  mocks.fetchCanvas
    .mockResolvedValueOnce(canvas())
    .mockResolvedValue(canvas("revision-2"));
  const view = render(<CanvasPage />);
  await view.findByTestId("editor");
  refresh();
  refresh();
  refresh();
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
  await Promise.resolve();
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
  changed({ ...message, canvasId: "canvas-b" });
  changed({ ...message, projectId: "project-b" });
  expect(mocks.fetchCanvas).toHaveBeenCalledOnce();
  mocks.fetchCanvas.mockResolvedValue(canvas(message.revision));
  changed(message);
  changed(message);
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
  changed(message);
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
  changed({ ...message, deleted: false });
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
  late({
    type: "canvas.document.updated",
    canvasId: "canvas-a",
    projectId: "project-a",
    deleted: false,
  });
  expect(mocks.fetchCanvas).toHaveBeenCalledTimes(count);
});
