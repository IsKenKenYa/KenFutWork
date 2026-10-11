import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

/**
 * 融合后 Design 主区的行为锁（原 workbench-surface 不变量迁到壳内嵌面）：
 * 主区恒为画布 iframe——列表回来后自动进画布（选中/自动建）、项目消息只认自身
 * iframe、iframe src 取项目主画布 id，不被任何对话框顶掉。
 *
 * 选中记忆是**模块级**状态（跨视图切换不丢画布），测试间必须 vi.resetModules
 * 隔离——否则上一例的选中 id 会把下一例的自动进画布判定整个短路。
 */
const designProject = (id: string, name: string, canvasId = `canvas-${id}`) => ({
  id,
  name,
  kind: "design" as const,
  primaryCanvas: { id: canvasId },
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
});

function installProjects(projects: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/api/projects?kind=design"))
      return Response.json({ projects });
    throw new Error(`意外的请求：${path}`);
  });
}

/** 每例拿一个干净的 HostDesignSurface（模块状态零残留）。 */
async function loadSurface() {
  const module = await import(
    "../src/components/workbench/zcode/host/DesignSurface"
  );
  return module.HostDesignSurface;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("列表回来后自动选第一个项目，主区即画布 iframe（src 取主画布 id）", async () => {
  vi.stubGlobal(
    "fetch",
    installProjects([designProject("p1", "页面稿"), designProject("p2", "概念图")]),
  );
  const HostDesignSurface = await loadSurface();
  render(<HostDesignSurface />);
  const frame = (await screen.findByTitle(
    "页面稿 画布",
    {},
    { timeout: 5000 },
  )) as HTMLIFrameElement;
  expect(frame.getAttribute("src")).toBe("/canvas?id=canvas-p1&panel=chat");
});

it("空列表自动建一张「未命名画布」并进入", async () => {
  let created = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/api/projects?kind=design"))
        return Response.json({ projects: [] });
      if (path.endsWith("/api/projects") && init?.method === "POST") {
        created++;
        return Response.json({
          project: designProject(`new-${created}`, "未命名画布"),
        });
      }
      throw new Error(`意外的请求：${path}`);
    }),
  );
  const HostDesignSurface = await loadSurface();
  render(<HostDesignSurface />);
  const frame = (await screen.findByTitle(
    "未命名画布 画布",
    {},
    { timeout: 5000 },
  )) as HTMLIFrameElement;
  expect(frame.getAttribute("src")).toBe("/canvas?id=canvas-new-1&panel=chat");
});

it("画布 iframe 的 project-created 消息刷新列表并选中新项目；来历不明的同消息不生效", async () => {
  vi.stubGlobal(
    "fetch",
    installProjects([designProject("p1", "页面稿")]),
  );
  const HostDesignSurface = await loadSurface();
  render(<HostDesignSurface />);
  const frame = (await screen.findByTitle(
    "页面稿 画布",
    {},
    { timeout: 5000 },
  )) as HTMLIFrameElement;
  const fromFrame = (data: unknown, source: Window | null) =>
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source,
        data,
      }),
    );
  // 非画布 iframe 来源：忽略。
  fromFrame(
    { type: "workbench:project-created", projectId: "p2" },
    window,
  );
  await waitFor(() =>
    expect(screen.getByTitle("页面稿 画布")).toBe(frame),
  );
  // 画布 iframe 上报新项目：列表刷新并切到新画布。
  const refreshed = installProjects([
    designProject("p1", "页面稿"),
    designProject("p2", "新稿"),
  ]);
  vi.stubGlobal("fetch", refreshed);
  await act(async () => {
    fromFrame(
      { type: "workbench:project-created", projectId: "p2" },
      frame.contentWindow,
    );
  });
  const next = await screen.findByTitle(
    "新稿 画布",
    {},
    { timeout: 5000 },
  );
  expect((next as HTMLIFrameElement).getAttribute("src")).toBe(
    "/canvas?id=canvas-p2&panel=chat",
  );
});

it("顶部选择器手动切项目即换画布；删除当前项目后回落到剩余项目", async () => {
  const store = [designProject("p1", "页面稿"), designProject("p2", "概念图")];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/api/projects?kind=design"))
        return Response.json({ projects: [...store] });
      if (path.endsWith("/api/projects/p1") && init?.method === "DELETE") {
        const index = store.findIndex((project) => project.id === "p1");
        if (index >= 0) store.splice(index, 1);
        return Response.json({ ok: true });
      }
      throw new Error(`意外的请求：${path}`);
    }),
  );
  const HostDesignSurface = await loadSurface();
  render(<HostDesignSurface />);
  await screen.findByTitle("页面稿 画布", {}, { timeout: 5000 });
  fireEvent.click(screen.getByRole("button", { name: "概念图" }));
  expect(
    (screen.getByTitle("概念图 画布") as HTMLIFrameElement).getAttribute("src"),
  ).toBe("/canvas?id=canvas-p2&panel=chat");
  fireEvent.click(screen.getByRole("button", { name: "页面稿" }));
  await screen.findByTitle("页面稿 画布", {}, { timeout: 5000 });
  fireEvent.click(screen.getByRole("button", { name: "删除 页面稿" }));
  // 删除后回落到剩余列表的第一个（概念图），不再自动建新画布。
  await waitFor(() =>
    expect(
      (screen.getByTitle("概念图 画布") as HTMLIFrameElement).getAttribute(
        "src",
      ),
    ).toBe("/canvas?id=canvas-p2&panel=chat"),
  );
  expect(screen.queryByTitle("页面稿 画布")).toBeNull();
});
