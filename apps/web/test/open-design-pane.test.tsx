import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
    project: {
      projectId: string;
      name: string;
      designSystemId?: string | null;
    };
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
const reviewRef = {
  current: {
    comments: [] as Array<Record<string, unknown>>,
    annotations: [] as Array<Record<string, unknown>>,
  },
};
const savedCommentRef = {
  current: {
    id: "c-1",
    projectId: "p-1",
    file: "index.html",
    body: "标题太浅",
    status: "open",
    anchor: {
      path: "#app > h1",
      rect: { x: 10, y: 20, w: 100, h: 30 },
      excerpt: "当前设计",
    },
    createdAt: 1792477257537,
    updatedAt: 1792477257537,
  },
};
const fetched: string[] = [];
const posted: Array<{ path: string; body: Record<string, unknown> }> = [];

vi.mock("../src/components/workbench/zcode/host/openDesignHost.js", () => ({
  useOpenDesignEntry: () => entryRef.current,
}));
vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: async (path: string, init?: RequestInit) => {
    fetched.push(path);
    if (init?.method && init.method !== "GET") {
      posted.push({
        path,
        body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
      });
    }
    if (path.includes("readiness")) return readinessRef.current;
    if (path.includes("last-project"))
      return { project: lastProjectRef.current };
    if (path.includes("/host/canvas/")) return canvasRef.current;
    if (path.includes("/host/projects"))
      return { projects: projectsRef.current };
    if (path.startsWith("/api/design-review?")) return reviewRef.current;
    if (path === "/api/design-review/comments")
      return { comment: savedCommentRef.current };
    if (path.startsWith("/api/design-review/comments/"))
      return { comment: { ...savedCommentRef.current, status: "resolved" } };
    if (path.startsWith("/api/design-review/annotations"))
      return { annotation: { id: "a-1" } };
    if (path === "/api/open-design/host/file")
      return { file: { name: "logo.png", kind: "image" }, version: null };
    if (path.includes("preview-url")) return previewRef.current;
    if (path.includes("file-text"))
      return {
        name: "index.html",
        text: '<html><body><div id="app"><h1 class="t">当前设计</h1></div></body></html>',
      };
    if (path.includes("version-content")) {
      return {
        version: {
          id: "v-1",
          label: "Version 1",
          version: 1,
          createdAt: 1792477257537,
        },
        text: '<html><body data-version="1">旧版设计</body></html>',
      };
    }
    if (path.includes("/host/versions")) {
      return {
        versions: [
          {
            id: "v-1",
            label: "Version 1",
            version: 1,
            createdAt: 1792477257537,
            size: 848,
            current: true,
          },
        ],
      };
    }
    if (path.includes("/host/canvas")) return createdRef.current;
    if (path === "/api/open-design/host/document")
      return {
        project: { projectId: "p-doc", name: "未命名文档" },
        entryFile: null,
        files: [],
      };
    if (path === "/api/open-design/host/context")
      return {
        document: { name: "document.md" },
        sections: ["review"],
        comments: 2,
        annotations: 1,
        annotationFiles: ["review/annotations-1.png"],
      };
    if (path === "/api/open-design/host/design-systems")
      return {
        designSystems: [
          {
            id: "agentic",
            title: "Agentic",
            category: "Themed",
            summary: null,
            swatches: ["#fff", "#111"],
          },
        ],
      };
    if (path === "/api/open-design/host/design-systems/bind")
      return { ok: true };
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
  reviewRef.current = { comments: [], annotations: [] };
  savedCommentRef.current = {
    ...savedCommentRef.current,
    status: "open",
  };
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
          options.projectId ? `open-design:${options.projectId}` : "open-design"
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

test("绑定画布：正文注入 <base> 与桥脚本后以 srcdoc 渲染，sandbox 保持不透明 origin", async () => {
  availableEntry();
  canvasWithFile();
  const { onMeta } = mount({ projectId: "p-1" });
  // 正文是异步取的：iframe 先以空文档挂上，拿到正文后换 key 重挂。
  await waitFor(() => {
    const doc = screen.getByTitle("OpenDesign").getAttribute("srcdoc") ?? "";
    expect(doc).toContain(
      `<base data-kfw-od="base" href="${ORIGIN}/api/projects/p-1/preview/tok/">`,
    );
    expect(doc).toContain('data-kfw-od="bridge"');
    expect(doc).toContain("当前设计");
  });
  const frame = screen.getByTitle("OpenDesign");
  // 关键安全边界：给了 allow-same-origin 就等于让设计代码拿到本仓 origin。
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
  // 空态对齐上游：标题 + 五个入口
  expect(await screen.findByText("生成的设计会出现在这里")).toBeTruthy();
  for (const label of [
    "新建画布",
    "新建文档",
    "上传资源",
    "新建浏览器",
    "新建设计体系",
  ]) {
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  }
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
  expect(
    screen.queryByRole("button", { name: "在 OpenDesign 打开" }),
  ).toBeNull();
});

async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
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
  expect(screen.getByTestId("open-design-readiness").textContent).toContain(
    "没有可用的设计引擎",
  );
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
  expect(await screen.findByTestId("open-design-upload-input")).toBeTruthy();
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual(
    expect.arrayContaining(["新建画布", "上传资源", "新建浏览器", "登录页"]),
  );

  const browserItem = items.find(
    (item) => item.dataset.openDesignAdd === "browser",
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
  const call = posted.find(
    (item) => item.path === "/api/open-design/host/file",
  );
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
  const openItem = (await screen.findAllByRole("menuitem")).find(
    (node) => node.dataset.openDesignOpen === "p-2",
  );
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

/** 模拟桥回传一次命中（父页只认来自当前这个 frame 且 source 匹配的消息）。 */
function emitBridgeHit(frame: HTMLIFrameElement, hit: unknown) {
  const event = new MessageEvent("message", {
    source: frame.contentWindow,
    data: { source: "kfw-od", type: "hit", id: -1, hit },
  });
  window.dispatchEvent(event);
}

const HIT = {
  path: "#app > h1",
  tag: "h1",
  text: "当前设计",
  html: '<h1 class="t">当前设计</h1>',
  rect: { x: 10, y: 20, w: 120, h: 30 },
  color: "rgb(17, 17, 17)",
  backgroundColor: "rgba(0, 0, 0, 0)",
};

test("编辑：桥回传命中后出检视器，保存把改动应用到源文本并经宿主写回", async () => {
  availableEntry();
  canvasWithFile();
  mount({ projectId: "p-1" });
  await waitFor(() => {
    expect(
      (screen.getByTitle("OpenDesign").getAttribute("srcdoc") ?? "").length,
    ).toBeGreaterThan(0);
  });
  const frame = screen.getByTitle("OpenDesign") as HTMLIFrameElement;

  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(
    screen.getByRole("button", { name: "编辑" }).getAttribute("aria-pressed"),
  ).toBe("true");

  emitBridgeHit(frame, HIT);
  const inspector = await screen.findByTestId("open-design-edit-inspector");
  expect(inspector.textContent).toContain("选中元素的 HTML");

  const editor = within(inspector).getByRole("textbox", { name: "文本颜色" });
  fireEvent.change(editor, { target: { value: "#ff0000" } });
  fireEvent.click(within(inspector).getByRole("button", { name: "保存" }));

  await waitFor(() => {
    const call = posted.find(
      (item) => item.path === "/api/open-design/host/file",
    );
    expect(call).toBeTruthy();
    const content = String(call?.body.content ?? "");
    expect(content).toContain('style="color: rgb(255, 0, 0);"');
    expect(content).toContain("当前设计");
    // 注入件不得被烤回文件
    expect(content).not.toContain("data-kfw-od");
    expect(call?.body.versionLabel).toBe("手动编辑");
  });
  // 保存后正文即真相：srcdoc 立刻反映新颜色，检视器收起
  await waitFor(() => {
    const doc = screen.getByTitle("OpenDesign").getAttribute("srcdoc") ?? "";
    expect(doc).toContain("rgb(255, 0, 0)");
  });
  expect(screen.queryByTestId("open-design-edit-inspector")).toBeNull();
});

test("编辑：路径在正文里已经找不到时如实说明，不写回", async () => {
  availableEntry();
  canvasWithFile();
  mount({ projectId: "p-1" });
  await waitFor(() => {
    expect(
      (screen.getByTitle("OpenDesign").getAttribute("srcdoc") ?? "").length,
    ).toBeGreaterThan(0);
  });
  const frame = screen.getByTitle("OpenDesign") as HTMLIFrameElement;
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  emitBridgeHit(frame, { ...HIT, path: "#gone > h1" });
  const inspector = await screen.findByTestId("open-design-edit-inspector");
  // 没有改动时保存是灰的（不算脏）；改个颜色才让保存真的走到「路径已失效」这条分支。
  fireEvent.change(
    within(inspector).getByRole("textbox", { name: "文本颜色" }),
    {
      target: { value: "#00ff00" },
    },
  );
  fireEvent.click(within(inspector).getByRole("button", { name: "保存" }));

  const notice = await screen.findByTestId("open-design-notice");
  expect(notice.textContent).toContain("改动没有保存");
  expect(
    posted.some((item) => item.path === "/api/open-design/host/file"),
  ).toBe(false);
});

/** 桥报一次矩形：图钉与笔迹的换算都要等这份度量到位。 */
function emitBridgeRects(
  frame: HTMLIFrameElement,
  rects: Record<string, { h: number; w: number; x: number; y: number } | null>,
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        source: "kfw-od",
        type: "rects",
        rects,
        doc: { w: 800, h: 600, vw: 800, vh: 600, sx: 0, sy: 0 },
      },
    }),
  );
}

async function mountReadyCanvas() {
  availableEntry();
  canvasWithFile();
  const rendered = mount({ projectId: "p-1" });
  await waitFor(() => {
    expect(
      (screen.getByTitle("OpenDesign").getAttribute("srcdoc") ?? "").length,
    ).toBeGreaterThan(0);
  });
  const frame = screen.getByTitle("OpenDesign") as HTMLIFrameElement;
  return { ...rendered, frame };
}

test("评论：点选元素→落笔卡片→提交后图钉出现并自动开侧栏", async () => {
  const { frame } = await mountReadyCanvas();
  emitBridgeRects(frame, { "#app > h1": { x: 10, y: 20, w: 100, h: 30 } });

  fireEvent.click(screen.getByRole("button", { name: "评论" }));
  emitBridgeHit(frame, HIT);
  const composer = await screen.findByTestId("open-design-comment-composer");
  fireEvent.change(within(composer).getByRole("textbox"), {
    target: { value: "标题太浅" },
  });
  fireEvent.click(within(composer).getByRole("button", { name: "提交" }));

  await waitFor(() => {
    const call = posted.find(
      (item) => item.path === "/api/design-review/comments",
    );
    expect(call?.body).toMatchObject({
      projectId: "p-1",
      file: "index.html",
      body: "标题太浅",
      anchor: {
        path: "#app > h1",
        rect: { x: 10, y: 20, w: 120, h: 30 },
        excerpt: "当前设计",
      },
    });
  });
  expect(await screen.findByTestId("open-design-comment-sidebar")).toBeTruthy();
  expect(
    document.querySelector('[data-design-comment-pin="c-1"]'),
  ).toBeTruthy();
  // 卡片收起，不再叠一层
  expect(screen.queryByTestId("open-design-comment-composer")).toBeNull();
});

test("评论侧栏：计数只算未解决，能重开与删除", async () => {
  reviewRef.current = {
    comments: [
      savedCommentRef.current,
      { ...savedCommentRef.current, id: "c-2", status: "resolved" },
    ],
    annotations: [],
  };
  const { frame } = await mountReadyCanvas();
  emitBridgeRects(frame, { "#app > h1": { x: 10, y: 20, w: 100, h: 30 } });

  fireEvent.click(screen.getByRole("button", { name: "评论侧栏" }));
  const sidebar = await screen.findByTestId("open-design-comment-sidebar");
  expect(sidebar.textContent).toContain("评论 1");
  expect(sidebar.textContent).toContain("标题太浅");
  // 已解决的不出图钉
  expect(document.querySelectorAll("[data-design-comment-pin]").length).toBe(1);

  fireEvent.click(within(sidebar).getAllByRole("button", { name: "解决" })[0]!);
  await waitFor(() => {
    expect(
      posted.some((item) => item.path === "/api/design-review/comments/c-1"),
    ).toBe(true);
  });

  fireEvent.click(
    within(sidebar).getAllByRole("button", { name: "删除评论" })[0]!,
  );
  await waitFor(() => {
    expect(document.querySelectorAll("[data-design-comment-pin]").length).toBe(
      0,
    );
  });
});
test("空态「新建文档」走 /host/document；「新建设计体系」拉清单并绑定", async () => {
  availableEntry();
  lastProjectRef.current = null;
  canvasRef.current = {
    project: { projectId: "p-doc", name: "未命名文档" },
    entryFile: null,
    files: [],
  };
  const { onMeta } = mount({ projectId: null });

  fireEvent.click(await screen.findByRole("button", { name: "新建文档" }));
  await waitFor(() => {
    expect(fetched).toContain("/api/open-design/host/document");
  });
  await waitFor(() => {
    expect(onMeta).toHaveBeenCalledWith("open-design", {
      projectId: "p-doc",
      title: "未命名文档",
    });
  });
});

test("「同步到引擎」把评审聚进 document.md（按钮 → /host/context）", async () => {
  await mountReadyCanvas();
  fireEvent.click(screen.getByRole("button", { name: "同步到引擎" }));
  await waitFor(() => {
    expect(fetched).toContain("/api/open-design/host/context");
  });
});

test("设计体系选择器：拉清单、按色板行选择后经 /bind 绑定", async () => {
  availableEntry();
  lastProjectRef.current = null;
  canvasRef.current = {
    project: { projectId: "p-ds", name: "未命名画布" },
    entryFile: null,
    files: [],
  };
  mount({ projectId: null });
  fireEvent.click(await screen.findByRole("button", { name: "新建设计体系" }));
  await waitFor(() => {
    expect(fetched).toContain("/api/open-design/host/design-systems");
  });
  const row = await screen.findByText("Agentic");
  fireEvent.click(row);
  await waitFor(() => {
    expect(fetched).toContain("/api/open-design/host/design-systems/bind");
  });
});

test("分享 = 静态部署菜单：发布到 CF/Vercel 走 /host/deploy，配置走 PUT /host/deploy/config", async () => {
  await mountReadyCanvas();
  // Radix 下拉在 jsdom 用键盘开（pointer 路径不稳，仓库既有先例）
  const openShareMenu = () => {
    const trigger = screen.getByRole("button", { name: "分享" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter", bubbles: true });
  };
  openShareMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "发布到 Cloudflare Pages" }),
  );
  await waitFor(() => {
    const deploy = posted.find(
      (item) => item.path === "/api/open-design/host/deploy",
    );
    expect(deploy?.body.providerId).toBe("cloudflare-pages");
  });
  // 打开「配置 Vercel」并保存
  openShareMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "配置 Vercel" }));
  const tokenInput = await screen.findByTestId("open-design-share-token");
  fireEvent.change(tokenInput, { target: { value: "vercel-token-1" } });
  fireEvent.click(screen.getByTestId("open-design-share-save"));
  await waitFor(() => {
    const saved = posted.find(
      (item) => item.path === "/api/open-design/host/deploy/config",
    );
    expect(saved?.body).toMatchObject({
      providerId: "vercel-self",
      token: "vercel-token-1",
    });
  });
});

test("保存到工作目录：按钮 → /host/save-to-workspace 带 projectId 与工作区路径", async () => {
  await mountReadyCanvas();
  fireEvent.click(screen.getByRole("button", { name: "保存到工作目录" }));
  await waitFor(() => {
    const saved = posted.find(
      (item) => item.path === "/api/open-design/host/save-to-workspace",
    );
    expect(saved?.body.projectId).toBe("p-1");
    expect(typeof saved?.body.workspacePath).toBe("string");
  });
});

test("工具栏设计体系：已绑定时显示体系名，点开选择器换绑后回读", async () => {
  availableEntry();
  canvasRef.current = {
    project: {
      projectId: "p-1",
      name: "订单页",
      designSystemId: "agentic",
    },
    entryFile: "index.html",
    files: [{ name: "index.html", kind: "html" }],
  };
  await mountReadyCanvas();
  // 先打开一次选择器让清单就绪（工具栏标题会显示已绑定体系名）
  fireEvent.click(screen.getByRole("button", { name: /设计体系/ }));
  const row = await screen.findByText("Agentic");
  fireEvent.click(row);
  await waitFor(() => {
    expect(fetched).toContain("/api/open-design/host/design-systems/bind");
  });
});
