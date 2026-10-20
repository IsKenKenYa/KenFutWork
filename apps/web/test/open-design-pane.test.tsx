import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const { TooltipProvider } = await import(
  "../src/components/workbench/zcode/components/ui/tooltip.js"
);

const entryRef = { current: null as unknown };
const lastProjectRef = {
  current: null as { projectId: string; name: string } | null,
};
const readinessRef = { current: { reachable: true, agentAvailable: true } };
const canvasRef = {
  current: null as null | {
    project: { projectId: string; name: string };
    entryFile: string | null;
    files: Array<{ name: string; kind: string }>;
  },
};
const previewRef = {
  current: {
    url: "/api/projects/p-1/preview/tok/index.html",
    iframeSandbox: "allow-scripts allow-forms",
  },
};
const createdRef = {
  current: { project: { projectId: "p-new", name: "未命名画布" } },
};
const projectsRef = {
  current: [
    { projectId: "p-1", name: "订单页", updatedAt: 3 },
    { projectId: "p-2", name: "登录页", updatedAt: 2 },
  ],
};
const fetched: string[] = [];
const posted: Array<{ path: string; body: Record<string, unknown> }> = [];

vi.mock("../src/components/workbench/zcode/host/openDesignHost.js", () => ({
  useOpenDesignEntry: () => entryRef.current,
}));
vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: async (path: string, init?: RequestInit) => {
    fetched.push(path);
    if (init?.method === "POST") {
      posted.push({
        path,
        body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
      });
    }
    if (path.includes("readiness")) return readinessRef.current;
    if (path.includes("last-project")) return { project: lastProjectRef.current };
    if (path.includes("/host/canvas/")) return canvasRef.current;
    if (path.includes("/host/projects")) return { projects: projectsRef.current };
    if (path === "/api/open-design/host/file")
      return { file: { name: "logo.png", kind: "image" }, version: null };
    if (path.includes("preview-url")) return previewRef.current;
    if (path.includes("file-text")) return { name: "index.html", text: "<html><body>当前设计</body></html>" };
    if (path.includes("version-content")) {
      return {
        version: { id: "v-1", label: "Version 1", version: 1, createdAt: 1792477257537 },
        text: '<html><body data-version="1">旧版设计</body></html>',
      };
    }
    if (path.includes("/host/versions")) {
      return {
        versions: [
          { id: "v-1", label: "Version 1", version: 1, createdAt: 1792477257537, size: 848, current: true },
        ],
      };
    }
    if (path.includes("/host/canvas")) return createdRef.current;
    throw new Error(`unexpected path ${path}`);
  },
}));

const { OpenDesignPane } = await import(
  "../src/components/workbench/zcode/host/OpenDesignPane.js"
);

const ORIGIN = "http://127.0.0.1:7456";

afterEach(() => {
  cleanup();
  entryRef.current = null;
  lastProjectRef.current = null;
  readinessRef.current = { reachable: true, agentAvailable: true };
  canvasRef.current = null;
  fetched.length = 0;
  posted.length = 0;
  vi.clearAllMocks();
});

function mount(options: { projectId: string | null }) {
  const onMeta = vi.fn();
  const onOpenBrowserTab = vi.fn();
  const view = render(
    <TooltipProvider>
      <OpenDesignPane
        tabId={
          options.projectId
            ? `open-design:${options.projectId}`
            : "open-design"
        }
        projectId={options.projectId}
        onMeta={onMeta}
        workspacePath="C:/workspace"
        onOpenBrowserTab={onOpenBrowserTab}
      />
    </TooltipProvider>,
  );
  return { view, onMeta, onOpenBrowserTab };
}

function availableEntry() {
  entryRef.current = { available: true, frontendUrl: ORIGIN };
}

function canvasWithFile(projectId = "p-1", name = "订单页") {
  canvasRef.current = {
    project: { projectId, name },
    entryFile: "index.html",
    files: [{ name: "index.html", kind: "html" }],
  };
}

test("绑定画布：预览 iframe 用上游公开地址 + 下发 sandbox，画布名回写标签", async () => {
  availableEntry();
  canvasWithFile();
  const { onMeta } = mount({ projectId: "p-1" });
  const frame = await screen.findByTitle("OpenDesign");
  expect(frame.getAttribute("src")).toBe(
    `${ORIGIN}/api/projects/p-1/preview/tok/index.html`,
  );
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  await waitFor(() => {
    expect(onMeta).toHaveBeenCalledWith("open-design:p-1", { title: "订单页" });
  });
});

test("未绑定（旧状态）：退回最近画布并写回绑定，不要求重挂", async () => {
  availableEntry();
  lastProjectRef.current = { projectId: "p-9", name: "登录页" };
  canvasRef.current = {
    project: { projectId: "p-9", name: "登录页" },
    entryFile: "index.html",
    files: [{ name: "index.html", kind: "html" }],
  };
  const { onMeta } = mount({ projectId: null });
  await screen.findByTitle("OpenDesign");
  expect(onMeta).toHaveBeenCalledWith("open-design", {
    projectId: "p-9",
    title: "登录页",
  });
});

test("没有画布：空态给「新建画布」，点它走宿主代理新建并写回标签", async () => {
  availableEntry();
  lastProjectRef.current = null;
  canvasRef.current = {
    project: { projectId: "p-new", name: "未命名画布" },
    entryFile: null,
    files: [],
  };
  const { onMeta } = mount({ projectId: null });
  expect(await screen.findByText("还没有画布")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "新建画布" }));
  await waitFor(() => {
    expect(fetched).toContain("/api/open-design/host/canvas");
  });
  await waitFor(() => {
    expect(onMeta).toHaveBeenCalledWith("open-design", {
      projectId: "p-new",
      title: "未命名画布",
    });
  });
});

test("画布没有入口文件：说清楚「还没有内容」，不挂空 iframe", async () => {
  availableEntry();
  canvasRef.current = {
    project: { projectId: "p-1", name: "订单页" },
    entryFile: null,
    files: [{ name: "notes.md", kind: "markdown" }],
  };
  mount({ projectId: "p-1" });
  expect(await screen.findByText("画布还没有内容")).toBeTruthy();
  expect(screen.queryByTitle("OpenDesign")).toBeNull();
});

test("工具栏逐项对应上游：刷新/预览/代码/设备/截图/交给对话/历史/导出/分享/缩放", async () => {
  availableEntry();
  canvasWithFile();
  mount({ projectId: "p-1" });
  await screen.findByTitle("OpenDesign");
  for (const label of [
    "刷新",
    "预览",
    "代码",
    "设备",
    "截图到对话",
    "交给对话",
    "历史记录",
    "导出",
    "分享",
    "缩放",
  ]) {
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  }
  // 用户口径：不要「在 OpenDesign 打开」这个逃生口。
  expect(screen.queryByRole("button", { name: "在 OpenDesign 打开" })).toBeNull();
});

async function openMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  const trigger = screen.getByRole("button", { name: label });
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
}

test("代码视图：切到代码读设计正文（上游「代码」视图）", async () => {
  availableEntry();
  canvasWithFile();
  mount({ projectId: "p-1" });
  await screen.findByTitle("OpenDesign");
  fireEvent.click(screen.getByRole("button", { name: "代码" }));
  const source = await screen.findByTestId("open-design-source");
  await waitFor(() => expect(source.textContent).toContain("当前设计"));
});

test("设备视口：切到手机把画布框收到 390×844（上游 Desktop/Tablet/Mobile）", async () => {
  availableEntry();
  canvasWithFile();
  const user = userEvent.setup();
  mount({ projectId: "p-1" });
  await screen.findByTitle("OpenDesign");
  await openMenu(user, "设备");
  await user.click(await screen.findByText("手机"));
  await waitFor(() => {
    const shell = screen.getByTestId("open-design-frame-shell");
    expect(shell.style.width).toBe("390px");
    expect(shell.style.height).toBe("844px");
  });
  // Radix 模态菜单关闭是动画收尾；等它彻底卸载，避免下一用例的点击被残留层吞掉。
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("历史记录：选中一个版本后显示历史横幅与对应正文", async () => {
  availableEntry();
  canvasWithFile();
  const user = userEvent.setup();
  mount({ projectId: "p-1" });
  await screen.findByTitle("OpenDesign");
  await openMenu(user, "历史记录");
  await user.click(await screen.findByText(/V1 · /));
  const banner = await screen.findByTestId("open-design-version-banner");
  expect(banner.textContent).toContain("正在查看历史版本 V1");
  const frame = screen.getByTitle("OpenDesign");
  expect(frame.getAttribute("data-od-version")).toBe("v-1");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "回到当前" }));
  await waitFor(() => {
    expect(screen.queryByTestId("open-design-version-banner")).toBeNull();
  });
});

test("交给对话：把设计文件当附件发给聚焦的 composer；没有时提示先点输入框", async () => {
  availableEntry();
  canvasWithFile();
  mount({ projectId: "p-1" });
  await screen.findByTitle("OpenDesign");
  fireEvent.click(screen.getByRole("button", { name: "交给对话" }));
  await waitFor(() => {
    expect(screen.getByTestId("open-design-notice").textContent).toContain(
      "先点一下对话输入框",
    );
  });
  expect(fetched.some((path) => path.includes("file-text"))).toBe(true);
});

test("上游没有可用设计引擎时，面板说明原因而不是让人对着空白画布猜", async () => {
  availableEntry();
  canvasWithFile();
  readinessRef.current = { reachable: true, agentAvailable: false };
  mount({ projectId: "p-1" });
  await screen.findByTitle("OpenDesign");
  expect(
    screen.getByTestId("open-design-readiness").textContent,
  ).toContain("没有可用的设计引擎");
});

test("入口未就绪：直接说明原因，不摆空壳", async () => {
  entryRef.current = { available: false, reason: "未安装 OpenDesign 插件。" };
  mount({ projectId: "p-1" });
  expect(screen.getByTestId("open-design-pane").textContent).toContain(
    "未安装 OpenDesign 插件。",
  );
});

test("「+」选择器：新建画布 / 上传资源 / 新建浏览器 / 打开已有画布", async () => {
  const user = userEvent.setup();
  availableEntry();
  canvasWithFile();
  const { onOpenBrowserTab } = mount({ projectId: "p-1" });
  await screen.findByTitle("OpenDesign");

  await openMenu(user, "新建");
  expect(
    await screen.findByTestId("open-design-upload-input"),
  ).toBeTruthy();
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual(
    expect.arrayContaining(["新建画布", "上传资源", "新建浏览器", "登录页"]),
  );

  const browserItem = items.find((item) =>
    item.dataset.openDesignAdd === "browser",
  );
  expect(browserItem).toBeTruthy();
  fireEvent.click(browserItem as HTMLElement);
  expect(onOpenBrowserTab).toHaveBeenCalledTimes(1);
});

test("「+」→「上传资源」：文件按 base64 经宿主写进当前画布", async () => {
  availableEntry();
  canvasWithFile();
  mount({ projectId: "p-1" });
  await screen.findByTitle("OpenDesign");

  const input = screen.getByTestId("open-design-upload-input");
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([1, 2, 3])], "logo.png")] },
  });

  await waitFor(() => {
    expect(posted.map((call) => call.path)).toContain(
      "/api/open-design/host/file",
    );
  });
  const call = posted.find((item) => item.path === "/api/open-design/host/file");
  expect(call?.body).toEqual({
    projectId: "p-1",
    name: "logo.png",
    content: "AQID",
    encoding: "base64",
  });
  const notice = await screen.findByTestId("open-design-notice");
  expect(notice.textContent).toContain("已上传 logo.png");
});

test("「+」→「打开画布」：当前标签换绑到那块画布并重读", async () => {
  const user = userEvent.setup();
  availableEntry();
  canvasWithFile("p-1", "订单页");
  const { onMeta } = mount({ projectId: "p-1" });
  await screen.findByTitle("OpenDesign");

  await openMenu(user, "新建");
  const openItem = (
    await screen.findAllByRole("menuitem")
  ).find((node) => node.dataset.openDesignOpen === "p-2");
  expect(openItem).toBeTruthy();
  fireEvent.click(openItem as HTMLElement);

  await waitFor(() => {
    expect(onMeta).toHaveBeenCalledWith("open-design:p-1", {
      projectId: "p-2",
      title: null,
    });
  });
  await waitFor(() => {
    expect(fetched).toContain("/api/open-design/host/canvas/p-2");
  });
});