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
 * 融合后 Design 模式的行为锁（原 workbench-surface 不变量迁到壳内嵌面）：
 * 侧栏内容（项目列表/新建/改名/删除）与主区画布共享 designProjects 模块存储；
 * 主区恒为画布 iframe（?panel=chat 默认开右面板），自动进画布按本列表过滤选中态，
 * 项目消息只认画布 iframe。选中记忆是模块级状态，测试间必须 vi.resetModules 隔离。
 */
const designProject = (
  id: string,
  name: string,
  canvasId = `canvas-${id}`,
) => ({
  id,
  name,
  kind: "design" as const,
  enabledModes: ["design"],
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

/** 每例拿一份干净的模块（模块级项目存储零残留）。 */
async function loadParts() {
  const surface = await import(
    "../src/components/workbench/zcode/host/DesignSurface"
  );
  const sidebar = await import(
    "../src/components/workbench/zcode/host/ModeSidebarContent"
  );
  return {
    HostDesignSurface: surface.HostDesignSurface,
    DesignProjectsSidebar: sidebar.DesignProjectsSidebar,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("列表回来后自动选第一个项目，主区即画布 iframe（panel=chat 默认开右面板）", async () => {
  vi.stubGlobal(
    "fetch",
    installProjects([
      designProject("p1", "页面稿"),
      designProject("p2", "概念图"),
    ]),
  );
  const { HostDesignSurface, DesignProjectsSidebar } = await loadParts();
  render(
    <>
      <DesignProjectsSidebar />
      <HostDesignSurface />
    </>,
  );
  const frame = (await screen.findByTitle(
    "页面稿 画布",
    {},
    { timeout: 5000 },
  )) as HTMLIFrameElement;
  expect(frame.getAttribute("src")).toBe("/canvas?id=canvas-p1&panel=chat");
});

it("空列表不创建；用户显式新建项目也不自动产生画布", async () => {
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
          project: {
            ...designProject(`new-${created}`, "未命名项目"),
            primaryCanvas: undefined,
          },
        });
      }
      throw new Error(`意外的请求：${path}`);
    }),
  );
  const { HostDesignSurface, DesignProjectsSidebar } = await loadParts();
  render(
    <>
      <DesignProjectsSidebar />
      <HostDesignSurface />
    </>,
  );
  await screen.findByText("还没有画布");
  expect(created).toBe(0);
  fireEvent.click(screen.getByLabelText("创建项目"));
  await screen.findByText("未命名项目");
  expect(created).toBe(1);
  expect(screen.queryByTitle("未命名项目 画布")).toBeNull();
});

it("画布 iframe 的 project-created 消息刷新并切新项目，来历不明同消息不生效；侧栏点选即换画布", async () => {
  vi.stubGlobal("fetch", installProjects([designProject("p1", "页面稿")]));
  const { HostDesignSurface, DesignProjectsSidebar } = await loadParts();
  render(
    <>
      <DesignProjectsSidebar />
      <HostDesignSurface />
    </>,
  );
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
  fromFrame({ type: "workbench:project-created", projectId: "p2" }, window);
  await waitFor(() => expect(screen.getByTitle("页面稿 画布")).toBe(frame));
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
  const next = await screen.findByTitle("新稿 画布", {}, { timeout: 5000 });
  expect((next as HTMLIFrameElement).getAttribute("src")).toBe(
    "/canvas?id=canvas-p2&panel=chat",
  );
  // 侧栏行点击换回 p1。
  fireEvent.click(screen.getByRole("button", { name: "页面稿" }));
  expect(
    (screen.getByTitle("页面稿 画布") as HTMLIFrameElement).getAttribute("src"),
  ).toBe("/canvas?id=canvas-p1&panel=chat");
});

it("侧栏删除当前项目后回落到剩余项目；行内改名提交", async () => {
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
      if (path.endsWith("/api/projects/p2") && init?.method === "PUT") {
        const renamed = designProject("p2", "新名字");
        const index = store.findIndex((project) => project.id === "p2");
        if (index >= 0) store[index] = renamed;
        return Response.json({ project: renamed });
      }
      throw new Error(`意外的请求：${path}`);
    }),
  );
  const { HostDesignSurface, DesignProjectsSidebar } = await loadParts();
  render(
    <>
      <DesignProjectsSidebar />
      <HostDesignSurface />
    </>,
  );
  await screen.findByTitle("页面稿 画布", {}, { timeout: 5000 });
  // 行内改名：点「重命名 概念图」→ 输入 → Enter
  fireEvent.click(screen.getByRole("button", { name: "重命名 概念图" }));
  const input = screen.getByLabelText("重命名");
  fireEvent.change(input, { target: { value: "新名字" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "新名字" })).toBeTruthy(),
  );
  // 删除当前（页面稿）：选中回落到剩余列表第一个（概念图），不再自动建新画布
  fireEvent.click(screen.getByRole("button", { name: "删除 页面稿" }));
  await waitFor(() =>
    expect(
      (screen.getByTitle("新名字 画布") as HTMLIFrameElement).getAttribute(
        "src",
      ),
    ).toBe("/canvas?id=canvas-p2&panel=chat"),
  );
  expect(screen.queryByTitle("页面稿 画布")).toBeNull();
});
