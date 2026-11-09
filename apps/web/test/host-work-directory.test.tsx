import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  surfaceJson: vi.fn(),
  selectDirectory: vi.fn(),
  hasSelectDirectory: true,
}));
vi.mock("@/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceFetch: vi.fn(),
  surfaceJson: host.surfaceJson,
  getSurfaceApiBase: () => "http://127.0.0.1:3001",
}));
vi.mock("@zui/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () =>
    host.hasSelectDirectory ? { selectDirectory: host.selectDirectory } : {},
}));

const STATUS = { enabled: true, registeredEditors: 1, reasons: [] };
const EDITORS = {
  editors: [
    {
      id: "gridcraft",
      title: "表格",
      category: "office",
      mount: "wasm-iframe",
      version: "0.11.1",
      installed: true,
    },
  ],
  dataDir: "D:/data/kenfutwork",
  install: {},
};
const workProject = (overrides: Record<string, unknown> = {}) => ({
  id: "work-1",
  kind: "work",
  name: "books",
  workDir: "D:/work/books",
  updatedAt: "2026-11-07T00:00:00Z",
  enabledModes: ["work"],
  ...overrides,
});

/** 每个用例都要重置模块注册表：目录绑定是模块级存储，跨用例会串状态。 */
async function mountSurface() {
  vi.resetModules();
  const { HostWorkSurface } = await import(
    "@/components/workbench/zcode/host/WorkSurface"
  );
  return render(<HostWorkSurface />);
}

beforeEach(() => {
  vi.resetAllMocks();
  host.hasSelectDirectory = true;
  host.surfaceJson.mockImplementation(
    async (path: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return { project: workProject(JSON.parse(init.body as string)) };
      if (path.startsWith("/api/projects")) return { projects: [] };
      return path.includes("/status") ? STATUS : EDITORS;
    },
  );
});

/** 取创建项目那次请求的 body；没有请求就直说，不用可选链糊过去。 */
function createProjectBody(): Record<string, unknown> {
  const call = host.surfaceJson.mock.calls.find(
    (item) => (item[1] as RequestInit | undefined)?.method === "POST",
  );
  const body = (call?.[1] as RequestInit | undefined)?.body;
  if (typeof body !== "string") throw new Error("没有发出创建项目的请求");
  return JSON.parse(body) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
});

describe("Work 面目录绑定", () => {
  it("没有 work 项目时给选择目录入口", async () => {
    await mountSurface();
    expect(
      await screen.findByRole("button", { name: "选择工作目录" }),
    ).toBeTruthy();
    expect(screen.queryByText("books")).toBeNull();
  });

  it("已有 work 项目时自动绑到最近更新的一份", async () => {
    host.surfaceJson.mockImplementation(async (path: string) =>
      path.startsWith("/api/projects")
        ? {
            projects: [
              workProject({
                id: "old",
                name: "旧目录",
                updatedAt: "2026-01-01T00:00:00Z",
              }),
              workProject({
                id: "new",
                name: "新目录",
                updatedAt: "2026-11-05T00:00:00Z",
              }),
            ],
          }
        : path.includes("/status")
          ? STATUS
          : EDITORS,
    );
    await mountSurface();
    const button = await screen.findByRole("button", { name: "更换工作目录" });
    expect(button.textContent).toContain("新目录");
    expect(button.getAttribute("title")).toBe("D:/work/books");
  });

  it("选目录后按目录名建 work 项目并绑上", async () => {
    host.selectDirectory.mockResolvedValue("D:/work/books/");
    await mountSurface();
    fireEvent.click(
      await screen.findByRole("button", { name: "选择工作目录" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "更换工作目录" })).toBeTruthy(),
    );
    expect(host.surfaceJson).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({ method: "POST" }),
    );
    expect(createProjectBody()).toEqual({
      kind: "work",
      name: "books",
      work_dir: "D:/work/books",
    });
  });

  it("盘根目录保留尾斜杠（`D:` 在 Windows 是相对路径）", async () => {
    host.selectDirectory.mockResolvedValue("D:/");
    await mountSurface();
    fireEvent.click(
      await screen.findByRole("button", { name: "选择工作目录" }),
    );
    await waitFor(() => expect(createProjectBody()).toBeTruthy());
    expect(createProjectBody().work_dir).toBe("D:/");
  });

  it("目录上的项目已启用 work 时复用那一份，不再创建", async () => {
    host.selectDirectory.mockResolvedValue("D:/work/books");
    host.surfaceJson.mockImplementation(
      async (path: string, init?: RequestInit) => {
        if (init?.method === "POST")
          throw new Error("不该为已启用 work 的项目再建一份");
        if (path.includes("kind=code"))
          return {
            projects: [
              workProject({
                kind: "code",
                name: "书本项目",
                enabledModes: ["code", "work"],
              }),
            ],
          };
        if (path.startsWith("/api/projects")) return { projects: [] };
        return path.includes("/status") ? STATUS : EDITORS;
      },
    );
    await mountSurface();
    fireEvent.click(
      await screen.findByRole("button", { name: "选择工作目录" }),
    );
    await waitFor(() => expect(screen.getByText("书本项目")).toBeTruthy());
    expect(host.surfaceJson).not.toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("目录上是纯 Code 项目时另立一份 work 项目（Code 文件必须走 Task 工作域）", async () => {
    host.selectDirectory.mockResolvedValue("D:/work/books");
    host.surfaceJson.mockImplementation(
      async (path: string, init?: RequestInit) => {
        if (init?.method === "POST")
          return {
            project: workProject({
              id: "work-new",
              name: "books",
              workDir: "D:/work/books",
            }),
          };
        if (path.includes("kind=code"))
          return {
            projects: [
              workProject({
                id: "code-1",
                kind: "code",
                name: "书本项目",
                enabledModes: ["code"],
              }),
            ],
          };
        if (path.startsWith("/api/projects")) return { projects: [] };
        return path.includes("/status") ? STATUS : EDITORS;
      },
    );
    await mountSurface();
    fireEvent.click(
      await screen.findByRole("button", { name: "选择工作目录" }),
    );
    await waitFor(() => expect(screen.getByText("books")).toBeTruthy());
    expect(createProjectBody()).toEqual({
      kind: "work",
      name: "books",
      work_dir: "D:/work/books",
      directory_choice: "independent",
    });
  });

  it("取消选择目录不改状态、不创建项目", async () => {
    host.selectDirectory.mockResolvedValue(null);
    await mountSurface();
    fireEvent.click(
      await screen.findByRole("button", { name: "选择工作目录" }),
    );
    await waitFor(() => expect(host.selectDirectory).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      host.surfaceJson.mock.calls.filter(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("绑定失败要把服务端原因说出来", async () => {
    host.selectDirectory.mockResolvedValue("D:/work/books");
    host.surfaceJson.mockImplementation(
      async (path: string, init?: RequestInit) => {
        if (init?.method === "POST")
          throw new Error("目标目录不可写，请换一个位置");
        if (path.startsWith("/api/projects")) return { projects: [] };
        return path.includes("/status") ? STATUS : EDITORS;
      },
    );
    await mountSurface();
    fireEvent.click(
      await screen.findByRole("button", { name: "选择工作目录" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "目标目录不可写",
    );
  });

  it("已绑定的目录不会因为 work 清单为空被冲掉（切进编辑器会再刷一次）", async () => {
    const created = workProject({ id: "work-bound", name: "书本项目" });
    host.selectDirectory.mockResolvedValue("D:/work/books");
    host.surfaceJson.mockImplementation(
      async (path: string, init?: RequestInit) => {
        if (init?.method === "POST") return { project: created };
        if (path.startsWith("/api/projects")) return { projects: [] };
        return path.includes("/status") ? STATUS : EDITORS;
      },
    );
    vi.resetModules();
    const store = await import(
      "@/components/workbench/zcode/host/workProjectDirectory"
    );
    await store.chooseWorkDirectory(host.selectDirectory);
    expect(store.getWorkDirectory()?.id).toBe("work-bound");
    await store.refreshWorkDirectory();
    expect(store.getWorkDirectory()?.id).toBe("work-bound");
  });

  it("宿主没有系统选择器时不放假按钮，已绑定只显示目录名", async () => {
    host.hasSelectDirectory = false;
    await mountSurface();
    expect(screen.queryByRole("button", { name: "选择工作目录" })).toBeNull();
    cleanup();

    host.hasSelectDirectory = false;
    host.surfaceJson.mockImplementation(async (path: string) =>
      path.startsWith("/api/projects")
        ? { projects: [workProject()] }
        : path.includes("/status")
          ? STATUS
          : EDITORS,
    );
    await mountSurface();
    expect(await screen.findByText("books")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更换工作目录" })).toBeNull();
  });
});
