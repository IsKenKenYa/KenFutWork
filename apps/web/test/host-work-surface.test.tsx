import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostWorkSurface } from "@/components/workbench/zcode/host/WorkSurface";
import {
  getWorkSurfaceView,
  openWorkEditors,
} from "@/components/workbench/zcode/host/workSurfaceState";

const host = vi.hoisted(() => ({
  surfaceJson: vi.fn(),
  surfaceFetch: vi.fn(),
}));
vi.mock("@/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceFetch: host.surfaceFetch,
  surfaceJson: host.surfaceJson,
  getSurfaceApiBase: () => "http://127.0.0.1:3001",
}));

const STATUS = { enabled: true, registeredEditors: 2, reasons: [] };
const EDITOR = (overrides: Record<string, unknown>) => ({
  id: "gridcraft",
  title: "表格",
  category: "office",
  repo: "https://github.com/storytold/gridcraft",
  license: "MIT OR Apache-2.0",
  mount: "wasm-iframe",
  pinned: {
    version: "0.11.1",
    asset: "gridcraft-web-0.11.1.zip",
    bytes: 7571063,
    sha256: "b".repeat(64),
    url: "https://github.com/storytold/gridcraft/releases/download/v0.11.1/gridcraft-web-0.11.1.zip",
  },
  installed: false,
  ...overrides,
});
const EDITORS = (editors: unknown[], install = {}) => ({
  editors,
  dataDir: "D:/data/kenfutwork",
  install,
});

afterEach(() => {
  cleanup();
  openWorkEditors();
  host.surfaceJson.mockReset();
  host.surfaceFetch.mockReset();
  vi.restoreAllMocks();
});

function mockData(editors: unknown[], install = {}) {
  host.surfaceJson.mockImplementation(async (path: string) =>
    path.includes("/status") ? STATUS : EDITORS(editors, install),
  );
}

async function openInstalledEditor() {
  mockData([EDITOR({ installed: true })]);
  render(<HostWorkSurface />);
  await waitFor(() => expect(screen.getByText("打开")).toBeTruthy());
  fireEvent.click(screen.getByText("打开"));
  return screen.getByTitle("表格") as HTMLIFrameElement;
}

function postEditorMessage(
  frame: HTMLIFrameElement,
  data: Record<string, unknown>,
  origin = "http://127.0.0.1:3001",
) {
  fireEvent(
    window,
    new MessageEvent("message", {
      origin,
      source: frame.contentWindow,
      data,
    }),
  );
}

function workSaveCalls(post: ReturnType<typeof vi.spyOn>) {
  return post.mock.calls.filter(
    ([data]: [unknown, ...unknown[]]) =>
      (data as { type?: string }).type === "kenfutwork:work-save",
  );
}

function postSaveResult(
  saveId: string,
  ok: boolean,
  error?: string,
  path?: string | null,
) {
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: window.parent,
      data: { type: "kenfutwork:work-save-result", saveId, ok, error, path },
    }),
  );
}

describe("HostWorkSurface 信息页", () => {
  it("锚定已落位 → 「打开」；锚定未落位 → 「下载」；未锚定 → 如实标「未锚定」无按钮", async () => {
    mockData([
      EDITOR({ installed: true }),
      EDITOR({
        id: "deckcraft",
        title: "演示",
        repo: "https://github.com/storytold/deckcraft",
        installed: false,
      }),
      EDITOR({
        id: "wordcraft",
        title: "文档",
        repo: "https://github.com/storytold/wordcraft",
        pinned: null,
      }),
    ]);
    render(<HostWorkSurface />);
    await waitFor(() => expect(screen.getByText("表格")).toBeTruthy());
    expect(screen.getByText("打开")).toBeTruthy();
    expect(screen.getByText("下载")).toBeTruthy();
    expect(screen.getByText("未锚定")).toBeTruthy();
    expect(screen.getAllByText("v0.11.1").length).toBe(2);
    expect(screen.queryByText("已就绪")).toBeNull();
  });

  it("点「下载」→ POST install 且出现安装中状态行；error 态给可读原因与重试", async () => {
    mockData([EDITOR({ installed: false })]);
    host.surfaceFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    render(<HostWorkSurface />);
    await waitFor(() => expect(screen.getByText("下载")).toBeTruthy());
    fireEvent.click(screen.getByText("下载"));
    await waitFor(() =>
      expect(host.surfaceFetch).toHaveBeenCalledWith(
        "/api/work/host/editors/gridcraft/install",
        { method: "POST" },
      ),
    );
    expect(screen.queryByText("打开")).toBeNull();

    // error 态：原因 + 重试
    cleanup();
    host.surfaceJson.mockImplementation(async (path: string) =>
      path.includes("/status")
        ? STATUS
        : {
            editors: [EDITOR({ installed: false })],
            dataDir: "D:/data",
            install: {
              gridcraft: {
                state: "error",
                logTail: ["安装失败：校验和不匹配"],
                error: "校验和不匹配：下载内容与锚定发布不一致，已丢弃。",
              },
            },
          },
    );
    render(<HostWorkSurface />);
    await waitFor(() =>
      expect(
        screen.getByText(/校验和不匹配：下载内容与锚定发布不一致/),
      ).toBeTruthy(),
    );
    expect(screen.getByText("重试")).toBeTruthy();
  });

  it("点「打开」→ 切到编辑器面：iframe 指向静态托管 + 顶部可返回信息页", async () => {
    mockData([EDITOR({ installed: true })]);
    render(<HostWorkSurface />);
    await waitFor(() => expect(screen.getByText("打开")).toBeTruthy());
    fireEvent.click(screen.getByText("打开"));
    expect(getWorkSurfaceView().kind).toBe("editor");
    // 顶栏是返回图标 + 注册表中的中文标题（编辑器面不再重复显示英文 id）。
    const frame = screen.getByTitle("表格") as HTMLIFrameElement;
    expect(frame.src).toBe(
      "http://127.0.0.1:3001/api/work/host/editors/gridcraft/index.html?theme=light",
    );
    fireEvent.click(screen.getByLabelText("返回编辑器列表"));
    expect(getWorkSurfaceView().kind).toBe("editors");
    await waitFor(() => expect(screen.getByText("打开")).toBeTruthy());
  });

  it("探针失败 → 可读报错；适配层 disabled → 原因透出（fail loud）", async () => {
    host.surfaceJson.mockImplementation(async (path: string) => {
      // 字体区也在信息页里请求；这里只让探针/注册表失败，错误提示保持唯一。
      if (path.includes("/fonts"))
        return { dir: "D:/data/work/fonts", fonts: [] };
      throw new Error("HTTP 404");
    });
    render(<HostWorkSurface />);
    await waitFor(() => expect(screen.getByText("HTTP 404")).toBeTruthy());

    cleanup();
    host.surfaceJson.mockImplementation(async (path: string) =>
      path.includes("/status")
        ? { enabled: false, registeredEditors: 0, reasons: ["缺什么。"] }
        : { editors: [], dataDir: "D:/data", install: {} },
    );
    render(<HostWorkSurface />);
    await waitFor(() => expect(screen.getByText("缺什么。")).toBeTruthy());
    expect(screen.getByText("未启用")).toBeTruthy();
  });
});

describe("HostWorkSurface 统一保存桥", () => {
  it("保存成功：校验 origin/source 并交付字节，同 saveId 并发与完成后重放只转发一次", async () => {
    const post = vi.spyOn(window.parent, "postMessage");
    const frame = await openInstalledEditor();
    const bytes = new TextEncoder().encode("workbook").buffer;
    const message = {
      type: "kenfutwork:editor-save",
      saveId: "save-1",
      fileName: "Book1.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes,
    };

    postEditorMessage(frame, message);
    postEditorMessage(frame, message);
    await waitFor(() => expect(workSaveCalls(post)).toHaveLength(1));
    postEditorMessage(frame, message);
    postEditorMessage(frame, message, "http://evil.local");
    expect(workSaveCalls(post)).toHaveLength(1);

    const [request, targetOrigin, transfer] = workSaveCalls(post)[0] as [
      Record<string, unknown>,
      string,
      ArrayBuffer[],
    ];
    expect(request).toMatchObject({
      type: "kenfutwork:work-save",
      saveId: "save-1",
      fileName: "Book1.xlsx",
      bytes,
    });
    expect(targetOrigin).toBe(window.location.origin);
    expect(transfer).toEqual([bytes]);
    postSaveResult("save-1", true, undefined, "D:\\Desktop\\test\\Book1.xlsx");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    // 成功必须说清落到哪：以前只清错误态，用户点了保存没有任何反馈。
    await waitFor(() =>
      expect(screen.getByText(/已保存.*Book1\.xlsx/)).toBeTruthy(),
    );
  });

  it("保存失败可读：同 saveId 不重复失败，新 saveId 允许显式重试", async () => {
    const post = vi.spyOn(window.parent, "postMessage");
    const frame = await openInstalledEditor();
    const message = {
      type: "kenfutwork:editor-save",
      saveId: "save-failed",
      fileName: "Book1.xlsx",
      bytes: new ArrayBuffer(1),
    };

    postEditorMessage(frame, message);
    postSaveResult("save-failed", false, "磁盘不可写");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("磁盘不可写"),
    );
    postEditorMessage(frame, message);
    expect(workSaveCalls(post)).toHaveLength(1);

    postEditorMessage(frame, { ...message, saveId: "save-retry" });
    await waitFor(() => expect(workSaveCalls(post)).toHaveLength(2));
    postSaveResult("save-retry", true);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    // 浏览器形态拿不到落盘路径，也要给一句「已保存」，不能静默。
    await waitFor(() =>
      expect(screen.getByText("已保存")).toBeTruthy(),
    );
  });
});

describe("HostWorkSurface 主题桥", () => {
  it("editor-ready 前不发送主题，ready 后发送当前主题", async () => {
    const post = vi.fn();
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get")
      .mockReturnValue({ postMessage: post } as unknown as Window);
    const frame = await openInstalledEditor();

    expect(post).not.toHaveBeenCalled();
    fireEvent.load(frame);
    expect(post).not.toHaveBeenCalled();
    postEditorMessage(frame, { type: "kenfutwork:editor-ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(
      { type: "kenfutwork:editor-theme", theme: "light" },
      "http://127.0.0.1:3001",
    );
  });
});
