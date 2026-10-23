import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarCanvasSection } from "../src/components/workbench/zcode/host/SidebarCanvasSection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubCanvases(canvases: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ canvases })),
  );
}

it("读取当前项目的画布列表，并标出主画布", async () => {
  stubCanvases([
    { id: "c1", name: "客厅方案", isPrimary: true },
    { id: "c2", name: "草图", isPrimary: false },
  ]);
  render(<SidebarCanvasSection projectId="p1" />);
  const list = await screen.findByRole("list", { name: "画布" });
  expect(list.textContent).toContain("客厅方案");
  expect(list.textContent).toContain("主画布");
  expect(list.querySelectorAll("li")).toHaveLength(2);
});

it("点画布即以常驻文档意图打开，携带项目与标题", async () => {
  stubCanvases([{ id: "c9", name: "电机外壳", isPrimary: false }]);
  const seen: unknown[] = [];
  const capture = (event: Event) => seen.push((event as CustomEvent).detail);
  window.addEventListener("kenfutwork:open-document", capture);
  try {
    render(<SidebarCanvasSection projectId="p9" />);
    const row = await screen.findByRole("button", { name: "电机外壳" });
    await act(async () => {
      row.click();
    });
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({
      projectId: "p9",
      documentId: "c9",
      title: "电机外壳",
    });
  } finally {
    window.removeEventListener("kenfutwork:open-document", capture);
  }
});

it("没有项目时不请求接口，只说明没有打开的项目", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<SidebarCanvasSection projectId={null} />);
  expect(await screen.findByText("未打开项目")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("接口失败时给出可读原因，不留空白", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ nope: true })),
  );
  render(<SidebarCanvasSection projectId="p1" />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("画布列表");
});
