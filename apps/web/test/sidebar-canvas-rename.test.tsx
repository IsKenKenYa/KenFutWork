import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ json: vi.fn(), open: vi.fn() }));

vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: mocks.json,
}));
vi.mock(
  "../src/components/workbench/zcode/host/conversationWorkContext.js",
  () => ({ requestCanvasDocumentOpen: mocks.open }),
);

import { CANVAS_DOCUMENT_UPDATED_EVENT } from "../src/components/workbench/zcode/host/canvasDocumentNavigation.js";
import { SidebarCanvasSection } from "../src/components/workbench/zcode/host/SidebarCanvasSection.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const canvasId = "20000000-0000-4000-8000-000000000001";
const revision = "a".repeat(64);

const detail = (name: string) => ({
  canvas: {
    id: canvasId,
    name,
    projectId,
    revision,
    content: { elements: [], appState: {}, files: {} },
  },
});

beforeEach(() => {
  mocks.json.mockReset();
  mocks.open.mockReset();
  mocks.json.mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method === "PATCH") return Promise.resolve(detail("海报"));
    if (String(path).includes("/canvases?") || String(path).endsWith("/canvases"))
      return Promise.resolve({
        canvases: [{ id: canvasId, name: "未命名画布", isPrimary: true }],
      });
    return Promise.resolve(detail("未命名画布"));
  });
});
afterEach(() => cleanup());

test("画布行可重命名：读 revision → 带乐观锁 PATCH → 更新列表并广播", async () => {
  const view = render(<SidebarCanvasSection projectId={projectId} />);
  await waitFor(() =>
    expect(view.getByText("未命名画布")).toBeTruthy(),
  );

  fireEvent.click(view.getByRole("button", { name: "重命名 未命名画布" }));
  const input = view.getByRole("textbox", { name: "重命名" });
  fireEvent.change(input, { target: { value: "海报" } });
  const updated = vi.fn();
  window.addEventListener(CANVAS_DOCUMENT_UPDATED_EVENT, updated);
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

  await waitFor(() => expect(view.getByText("海报")).toBeTruthy());
  const patch = mocks.json.mock.calls.find(
    ([, init]) => init?.method === "PATCH",
  );
  expect(patch).toBeDefined();
  expect(String(patch?.[0])).toBe(`/api/canvases/${canvasId}`);
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
    name: "海报",
    expectedName: "未命名画布",
    expectedRevision: revision,
  });
  expect(
    mocks.json.mock.calls.some(
      ([path, init]) =>
        String(path) === `/api/canvases/${canvasId}` && init === undefined,
    ),
  ).toBe(true);
  expect(updated).toHaveBeenCalledOnce();
  window.removeEventListener(CANVAS_DOCUMENT_UPDATED_EVENT, updated);
});

test("改名失败把原因写在行内，不静默吞掉", async () => {
  mocks.json.mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method === "PATCH") return Promise.reject(new Error("画布名称冲突"));
    if (String(path).endsWith("/canvases"))
      return Promise.resolve({
        canvases: [{ id: canvasId, name: "未命名画布", isPrimary: true }],
      });
    return Promise.resolve(detail("未命名画布"));
  });
  const view = render(<SidebarCanvasSection projectId={projectId} />);
  await waitFor(() => expect(view.getByText("未命名画布")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "重命名 未命名画布" }));
  const input = view.getByRole("textbox", { name: "重命名" });
  fireEvent.change(input, { target: { value: "海报" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain("画布名称冲突"),
  );
  expect(view.queryByText("海报")).toBeNull();
});

test("中文输入法回车上屏不提交改名", async () => {
  const view = render(<SidebarCanvasSection projectId={projectId} />);
  await waitFor(() => expect(view.getByText("未命名画布")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "重命名 未命名画布" }));
  const input = view.getByRole("textbox", { name: "重命名" });
  fireEvent.change(input, { target: { value: "海报" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", isComposing: true });
  expect(
    mocks.json.mock.calls.some(([, init]) => init?.method === "PATCH"),
  ).toBe(false);
});
