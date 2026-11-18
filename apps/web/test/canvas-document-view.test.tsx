import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DocumentPaneRendererProps } from "../src/components/workbench/zcode/host/DocumentPane.js";

const mocks = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: mocks.json,
}));

import {
  CANVAS_CREATE_REQUEST_EVENT,
  CANVAS_DELETE_REQUEST_EVENT,
  CanvasDocumentView,
} from "../src/components/workbench/zcode/host/CanvasDocumentView.js";
import {
  CANVAS_DOCUMENT_DELETED_EVENT,
  CANVAS_DOCUMENT_UPDATED_EVENT,
} from "../src/components/workbench/zcode/host/canvasDocumentNavigation.js";
import {
  clearCanvasConversationContext,
  getCanvasConversationContext,
  OPEN_DOCUMENT_EVENT,
} from "../src/components/workbench/zcode/host/conversationWorkContext.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const canvasId = "20000000-0000-4000-8000-000000000001";
const otherId = "20000000-0000-4000-8000-000000000002";
const revision = "a".repeat(64);
const rows = [
  { id: canvasId, name: "画布 A", isPrimary: true },
  { id: otherId, name: "画布 B", isPrimary: false },
];
function canvas(id = canvasId, name = "画布 A") {
  return {
    canvas: {
      id,
      name,
      projectId,
      revision,
      content: { elements: [], appState: {}, files: {} },
    },
  };
}
function props(
  overrides: Partial<DocumentPaneRendererProps> = {},
): DocumentPaneRendererProps {
  return {
    tab: {
      id: "document-a",
      type: "document",
      resourceType: "canvas",
      projectId,
      documentId: canvasId,
      workspaceKey: "workspace-a",
      title: "画布 A",
    },
    isVisible: true,
    workspaceAbsPath: "/workspace",
    activeTaskId: "task-a",
    ...overrides,
  };
}
/** 未指向具体画布的标签（进入 Design 的默认入口形态）。 */
function blank() {
  const input = props();
  delete input.tab.documentId;
  return input;
}
function frame(view: ReturnType<typeof render>) {
  const iframe = view.container.querySelector("iframe");
  if (!iframe?.contentWindow) throw new Error("Missing canvas frame");
  return { iframe, target: iframe.contentWindow };
}
function send(target: Window, data: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: window.location.origin,
      source: target,
      data: { projectId, canvasId, ...data },
    }),
  );
}
function ready(target: Window, x = 1) {
  send(target, {
    type: "kenfutwork:canvas-context",
    brandKitId: "brand-a",
    selectedCanvasElements: [{ id: "shape-a", x }],
  });
}
function acknowledgePrepare(target: Window) {
  return vi.spyOn(target, "postMessage").mockImplementation((message) => {
    if (message.type === "kenfutwork:canvas-prepare")
      send(target, {
        type: "kenfutwork:canvas-prepared",
        requestId: message.requestId,
        revision,
      });
  });
}
/** 等首轮画布列表落定（没有原生下拉可查了，用调用次数当同步点）。 */
async function listed(times = 1) {
  await waitFor(() => expect(mocks.json).toHaveBeenCalledTimes(times));
}

beforeEach(() => {
  mocks.json.mockReset().mockResolvedValue({ canvases: rows });
  clearCanvasConversationContext(projectId);
});
afterEach(() => {
  cleanup();
  clearCanvasConversationContext(projectId);
  vi.restoreAllMocks();
});

test("画布列表在途时不闪空态：项目有画布就全程不出现「还没有画布」", async () => {
  let release: () => void = () => {};
  mocks.json.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ canvases: rows });
      }),
  );
  const view = render(<CanvasDocumentView {...blank()} />);
  await waitFor(() => expect(mocks.json).toHaveBeenCalledOnce());
  const flashed = () =>
    (view.container.textContent ?? "").includes("还没有画布");
  // 列表还没回，不能凭「当前未选中」就下空态结论
  expect(flashed()).toBe(false);
  expect(view.queryByRole("button", { name: "新建画布" })).toBeNull();
  release();
  await waitFor(() => expect(mocks.json).toHaveBeenCalledOnce());
  expect(flashed()).toBe(false);
});

test("画布隐藏后保持iframe及选区/品牌，隐藏交互不抢共享会话", async () => {
  const focus = vi.fn();
  window.addEventListener("kenfutwork:focus-session", focus);
  const view = render(<CanvasDocumentView {...props()} />);
  const { iframe, target } = frame(view);
  const post = vi.spyOn(target, "postMessage").mockImplementation(() => {});
  ready(target);
  await waitFor(() =>
    expect(getCanvasConversationContext(projectId)?.brandKitId).toBe("brand-a"),
  );
  view.rerender(
    <CanvasDocumentView
      {...props({ isVisible: false, activeTaskId: "task-b" })}
    />,
  );
  expect(getCanvasConversationContext(projectId)).toBeNull();
  expect(post).toHaveBeenCalledWith(
    { type: "kenfutwork:workspace-activity", active: false },
    window.location.origin,
  );
  send(target, { type: "kenfutwork:canvas-focus-session" });
  ready(target, 3);
  expect(focus).not.toHaveBeenCalled();
  view.rerender(<CanvasDocumentView {...props({ activeTaskId: "task-b" })} />);
  expect(frame(view).iframe).toBe(iframe);
  expect(iframe.getAttribute("src")).toBe(`/canvas?id=${canvasId}&editor=1`);
  expect(
    getCanvasConversationContext(projectId)?.selectedCanvasElements,
  ).toEqual([{ id: "shape-a", x: 3 }]);
  expect(post).toHaveBeenCalledWith(
    {
      type: "kenfutwork:canvas-session-context",
      projectId,
      canvasId,
      taskId: "task-b",
    },
    window.location.origin,
  );
  window.removeEventListener("kenfutwork:focus-session", focus);
});

test("编辑器文档通知校验真实目标并更新列表，删除清理引用且不抢标签焦点", async () => {
  const updated = vi.fn();
  const deleted = vi.fn();
  const opened = vi.fn();
  window.addEventListener(CANVAS_DOCUMENT_UPDATED_EVENT, updated);
  window.addEventListener(CANVAS_DOCUMENT_DELETED_EVENT, deleted);
  window.addEventListener(OPEN_DOCUMENT_EVENT, opened);
  const view = render(<CanvasDocumentView {...props()} />);
  await listed();
  const { target } = frame(view);
  ready(target);
  await waitFor(() =>
    expect(getCanvasConversationContext(projectId)?.canvasId).toBe(canvasId),
  );
  const message = {
    type: "kenfutwork:canvas-document-updated",
    revision,
    deleted: false,
  };
  send(target, { ...message, projectId: otherId });
  send(target, { ...message, canvasId: otherId });
  send(target, { ...message, deleted: "false" });
  expect(updated).not.toHaveBeenCalled();
  send(target, message);
  await listed(2);
  expect(updated.mock.calls[0]?.[0].detail).toEqual({
    type: "canvas.document.updated",
    projectId,
    canvasId,
    revision,
    deleted: false,
  });
  send(target, { ...message, deleted: true });
  await listed(3);
  expect(deleted.mock.calls[0]?.[0].detail.canvasId).toBe(canvasId);
  expect(getCanvasConversationContext(projectId)).toBeNull();
  ready(target, 4);
  send(target, message);
  view.rerender(<CanvasDocumentView {...props({ isVisible: false })} />);
  view.rerender(<CanvasDocumentView {...props({ activeTaskId: "task-b" })} />);
  expect(getCanvasConversationContext(projectId)).toBeNull();
  expect(deleted).toHaveBeenCalledOnce();
  expect(updated).toHaveBeenCalledOnce();
  expect(opened).not.toHaveBeenCalled();
  window.removeEventListener(CANVAS_DOCUMENT_UPDATED_EVENT, updated);
  window.removeEventListener(CANVAS_DOCUMENT_DELETED_EVENT, deleted);
  window.removeEventListener(OPEN_DOCUMENT_EVENT, opened);
});

test("保留的画布列表在重新显示和同项目更新后重新对账", async () => {
  const input = props();
  const view = render(<CanvasDocumentView {...input} />);
  await listed();
  expect(mocks.json).toHaveBeenCalledTimes(1);
  view.rerender(<CanvasDocumentView {...input} isVisible={false} />);
  expect(mocks.json).toHaveBeenCalledTimes(1);
  view.rerender(<CanvasDocumentView {...input} isVisible />);
  await listed(2);
  window.dispatchEvent(
    new CustomEvent(CANVAS_DOCUMENT_UPDATED_EVENT, {
      detail: { projectId: "another-project", canvasId },
    }),
  );
  expect(mocks.json).toHaveBeenCalledTimes(2);
  window.dispatchEvent(
    new CustomEvent(CANVAS_DOCUMENT_UPDATED_EVENT, {
      detail: { projectId, canvasId },
    }),
  );
  await listed(3);
  expect(mocks.json.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

test("菜单动作转成宿主事件：新建走幂等创建并打开新内容", async () => {
  mocks.json.mockImplementation(async (_path, init) =>
    init?.method === "POST"
      ? canvas(otherId, "未命名画布")
      : { canvases: rows },
  );
  const opened = vi.fn();
  const create = vi.fn();
  window.addEventListener(OPEN_DOCUMENT_EVENT, opened);
  window.addEventListener(CANVAS_CREATE_REQUEST_EVENT, create);
  const view = render(<CanvasDocumentView {...props()} />);
  const { target } = frame(view);
  send(target, { type: "kenfutwork:canvas-create" });
  expect(create).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(
      mocks.json.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(true),
  );
  const mutation = mocks.json.mock.calls.find(
    ([, init]) => init?.method === "POST",
  );
  expect(mutation?.[0]).toBe(`/api/projects/${projectId}/canvases`);
  expect(JSON.parse(mutation?.[1].body).name).toBe("未命名画布");
  await waitFor(() => expect(opened).toHaveBeenCalledOnce());
  expect(opened.mock.calls[0]?.[0].detail).toEqual({
    projectId,
    documentId: otherId,
    title: "未命名画布",
  });
  window.removeEventListener(OPEN_DOCUMENT_EVENT, opened);
  window.removeEventListener(CANVAS_CREATE_REQUEST_EVENT, create);
});

test("删除画布先等待编辑器真实保存版本，删除事件指向对应项目文档", async () => {
  mocks.json.mockImplementation(async (_path, init) =>
    init?.method === "DELETE" ? { ok: true } : { canvases: rows },
  );
  const deleted = vi.fn();
  const remove = vi.fn();
  window.addEventListener(CANVAS_DOCUMENT_DELETED_EVENT, deleted);
  window.addEventListener(CANVAS_DELETE_REQUEST_EVENT, remove);
  const view = render(<CanvasDocumentView {...props()} />);
  const { target } = frame(view);
  acknowledgePrepare(target);
  ready(target);
  send(target, { type: "kenfutwork:canvas-delete" });
  expect(remove).toHaveBeenCalledOnce();
  await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
  const mutation = mocks.json.mock.calls.find(
    ([, init]) => init?.method === "DELETE",
  );
  expect(mutation?.[0]).toBe(`/api/canvases/${canvasId}`);
  expect(JSON.parse(mutation?.[1].body)).toEqual({
    expectedRevision: revision,
  });
  expect(deleted.mock.calls[0]?.[0].detail).toEqual({ projectId, canvasId });
  window.removeEventListener(CANVAS_DOCUMENT_DELETED_EVENT, deleted);
  window.removeEventListener(CANVAS_DELETE_REQUEST_EVENT, remove);
});

test("创建重试复用幂等请求，迟到创建结果不抢显式选择的新内容", async () => {
  let attempts = 0;
  let complete: ((value: ReturnType<typeof canvas>) => void) | undefined;
  mocks.json.mockImplementation(async (_path, init) => {
    if (init?.method !== "POST") return { canvases: [] };
    attempts++;
    if (attempts === 1) throw new Error("创建失败，请重试");
    return new Promise<ReturnType<typeof canvas>>((resolve) => {
      complete = resolve;
    });
  });
  const opened = vi.fn();
  window.addEventListener(OPEN_DOCUMENT_EVENT, opened);
  const view = render(<CanvasDocumentView {...blank()} />);
  fireEvent.click(await view.findByRole("button", { name: "新建画布" }));
  await view.findByRole("alert");
  fireEvent.click(view.getByRole("button", { name: "新建画布" }));
  await waitFor(() => expect(attempts).toBe(2));
  const bodies = mocks.json.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(init.body));
  expect(bodies[0].requestId).toBe(bodies[1].requestId);
  view.rerender(<CanvasDocumentView {...blank()} isVisible={false} />);
  complete?.(canvas(otherId, "未命名画布"));
  await waitFor(() => expect(opened).not.toHaveBeenCalled());
  window.removeEventListener(OPEN_DOCUMENT_EVENT, opened);
});
