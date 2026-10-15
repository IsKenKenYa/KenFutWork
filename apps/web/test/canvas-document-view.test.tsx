import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DocumentPaneRendererProps } from "../src/components/workbench/zcode/host/DocumentPane.js";

const mocks = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: mocks.json,
}));

import { CanvasDocumentView } from "../src/components/workbench/zcode/host/CanvasDocumentView.js";
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

beforeEach(() => {
  mocks.json.mockReset().mockResolvedValue({ canvases: rows });
  clearCanvasConversationContext(projectId);
});
afterEach(() => {
  cleanup();
  clearCanvasConversationContext(projectId);
  vi.restoreAllMocks();
});

test("空项目不自动创建画布，选择文档通过共享原标签打开", async () => {
  const input = props();
  delete input.tab.documentId;
  const opened = vi.fn();
  window.addEventListener(OPEN_DOCUMENT_EVENT, opened);
  const view = render(<CanvasDocumentView {...input} />);
  await waitFor(() =>
    expect(view.getByRole("option", { name: "画布 B" })).toBeTruthy(),
  );
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(
    mocks.json.mock.calls.some(([, options]) => options?.method === "POST"),
  ).toBe(false);
  fireEvent.change(view.getByRole("combobox", { name: "画布" }), {
    target: { value: otherId },
  });
  expect(opened).toHaveBeenCalledOnce();
  expect(opened.mock.calls[0]?.[0].detail).toEqual({
    projectId,
    documentId: otherId,
    title: "画布 B",
  });
  window.removeEventListener(OPEN_DOCUMENT_EVENT, opened);
});

test("保留的画布列表在显式聚焦、重新显示和同项目更新后重新对账", async () => {
  const input = props();
  delete input.tab.documentId;
  const view = render(<CanvasDocumentView {...input} />);
  await view.findByRole("option", { name: "画布 B" });
  mocks.json.mockResolvedValue({
    canvases: [
      ...rows,
      {
        id: "20000000-0000-4000-8000-000000000003",
        name: "新增画布",
        isPrimary: false,
      },
    ],
  });
  fireEvent.focus(view.getByRole("combobox", { name: "画布" }));
  await view.findByRole("option", { name: "新增画布" });
  expect(mocks.json).toHaveBeenCalledTimes(2);
  view.rerender(<CanvasDocumentView {...input} isVisible={false} />);
  expect(mocks.json).toHaveBeenCalledTimes(2);
  view.rerender(<CanvasDocumentView {...input} isVisible />);
  await waitFor(() => expect(mocks.json).toHaveBeenCalledTimes(3));
  window.dispatchEvent(
    new CustomEvent(CANVAS_DOCUMENT_UPDATED_EVENT, {
      detail: { projectId: "another-project", canvasId },
    }),
  );
  expect(mocks.json).toHaveBeenCalledTimes(3);
  window.dispatchEvent(
    new CustomEvent(CANVAS_DOCUMENT_UPDATED_EVENT, {
      detail: { projectId, canvasId },
    }),
  );
  await waitFor(() => expect(mocks.json).toHaveBeenCalledTimes(4));
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(mocks.json.mock.calls.every(([, init]) => !init?.method)).toBe(true);
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
  await view.findByRole("option", { name: "画布 B" });
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
  await waitFor(() => expect(mocks.json).toHaveBeenCalledTimes(2));
  expect(updated.mock.calls[0]?.[0].detail).toEqual({
    type: "canvas.document.updated",
    projectId,
    canvasId,
    revision,
    deleted: false,
  });
  send(target, { ...message, deleted: true });
  await waitFor(() => expect(mocks.json).toHaveBeenCalledTimes(3));
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

test("重命名先等待编辑器真实保存revision，再带名称与CAS提交", async () => {
  mocks.json.mockImplementation(async (_path, init) =>
    init?.method === "PATCH" ? canvas(canvasId, "海报") : { canvases: rows },
  );
  const view = render(<CanvasDocumentView {...props()} />);
  const { target } = frame(view);
  acknowledgePrepare(target);
  ready(target);
  await waitFor(() =>
    expect(view.getByRole("option", { name: "画布 A" })).toBeTruthy(),
  );
  fireEvent.change(view.getByRole("textbox", { name: "画布名称" }), {
    target: { value: "海报" },
  });
  fireEvent.click(view.getByRole("button", { name: "重命名" }));
  await waitFor(() =>
    expect(
      mocks.json.mock.calls.some(([, init]) => init?.method === "PATCH"),
    ).toBe(true),
  );
  const mutation = mocks.json.mock.calls.find(
    ([, init]) => init?.method === "PATCH",
  );
  expect(mutation?.[0]).toBe(`/api/canvases/${canvasId}`);
  expect(JSON.parse(mutation?.[1].body)).toEqual({
    name: "海报",
    expectedName: "画布 A",
    expectedRevision: revision,
  });
});

test("删除需显式确认并用保存后的版本，删除事件指向对应项目文档", async () => {
  mocks.json.mockImplementation(async (_path, init) =>
    init?.method === "DELETE" ? { ok: true } : { canvases: rows },
  );
  const deleted = vi.fn();
  window.addEventListener(CANVAS_DOCUMENT_DELETED_EVENT, deleted);
  const view = render(<CanvasDocumentView {...props()} />);
  const { target } = frame(view);
  acknowledgePrepare(target);
  ready(target);
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "删除" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(view.getByRole("button", { name: "删除" }));
  expect(
    mocks.json.mock.calls.some(([, init]) => init?.method === "DELETE"),
  ).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
  const mutation = mocks.json.mock.calls.find(
    ([, init]) => init?.method === "DELETE",
  );
  expect(JSON.parse(mutation?.[1].body)).toEqual({
    expectedRevision: revision,
  });
  expect(deleted.mock.calls[0]?.[0].detail).toEqual({ projectId, canvasId });
  window.removeEventListener(CANVAS_DOCUMENT_DELETED_EVENT, deleted);
});

test("创建重试复用幂等请求，迟到创建结果不抢显式选择的新内容", async () => {
  let attempts = 0;
  let complete: ((value: ReturnType<typeof canvas>) => void) | undefined;
  mocks.json.mockImplementation(async (_path, init) => {
    if (init?.method !== "POST") return { canvases: rows };
    attempts++;
    if (attempts === 1) throw new Error("创建失败，请重试");
    return new Promise<ReturnType<typeof canvas>>((resolve) => {
      complete = resolve;
    });
  });
  const opened = vi.fn();
  window.addEventListener(OPEN_DOCUMENT_EVENT, opened);
  const view = render(<CanvasDocumentView {...props()} />);
  fireEvent.click(view.getByRole("button", { name: "新建画布" }));
  await view.findByRole("alert");
  fireEvent.click(view.getByRole("button", { name: "新建画布" }));
  await waitFor(() => expect(attempts).toBe(2));
  const bodies = mocks.json.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(init.body));
  expect(bodies[0].requestId).toBe(bodies[1].requestId);
  view.rerender(<CanvasDocumentView {...props({ isVisible: false })} />);
  complete?.(canvas(otherId, "未命名画布"));
  await waitFor(() => expect(mocks.json).toHaveBeenCalledTimes(4));
  expect(opened).not.toHaveBeenCalled();
  window.removeEventListener(OPEN_DOCUMENT_EVENT, opened);
});
