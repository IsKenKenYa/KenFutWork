import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeWorkbenchFrame } from "../src/components/workbench/code-workbench-frame";
import { LOCAL_ACCESS_LOST_EVENT } from "../src/lib/local-access";

const themeHost = vi.hoisted(() => ({
  setTheme: vi.fn(),
  triggerDownload: vi.fn(),
}));
vi.mock("@/lib/download", () => ({
  triggerDownload: themeHost.triggerDownload,
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: "light",
    resolvedTheme: "light",
    setTheme: themeHost.setTheme,
  }),
}));

vi.mock("../src/lib/local-instance-context", () => ({
  useLocalInstance: () => ({
    instance: { instanceId: "instance", dataDir: "/data" },
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

afterEach(() => {
  // 本仓 vitest 未开 globals，Testing Library 的自动清理不会生效：手动清，
  // 否则上一条用例的组件留在 body 里，getByRole 会命中多个
  cleanup();
  vi.unstubAllGlobals();
  themeHost.setTheme.mockReset();
  themeHost.triggerDownload.mockReset();
  localStorage.clear();
});

it("插件入口只接受当前Code窗口，并按已启用且适用的库存打开现有面板", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      plugins: [
        {
          id: "bundled__mihome",
          installed: true,
          enabled: true,
          scope: "shared",
          ui: [
            {
              id: "devices",
              slot: "sidebar",
              title: "米家",
              url: "panel",
              icon: null,
            },
          ],
        },
      ],
    }),
  );
  render(<CodeWorkbenchFrame />);
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  const data = {
    type: "kenfutwork:code-open-plugin",
    pluginId: "bundled__mihome",
    entryId: "devices",
    url: "https://untrusted.example",
  };
  for (const source of [window, null])
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source,
        data,
      }),
    );
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "https://untrusted.example",
      source: frame.contentWindow,
      data,
    }),
  );
  expect(screen.queryByTitle("米家")).toBeNull();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data,
    }),
  );
  const panel = await screen.findByTitle("米家");
  expect(panel.getAttribute("src")).toBe(
    `${window.location.origin}/api/plugins/bundled__mihome/panel`,
  );
  expect(screen.getByTitle("Code 工作台")).toBe(frame);
});

it("窗口聚焦与模式能力更新交错时，插件打开仍读取最新库存，不静默取消", async () => {
  const payload = {
    plugins: [
      {
        id: "bundled__mihome",
        installed: true,
        enabled: true,
        scope: "shared",
        ui: [
          {
            id: "devices",
            slot: "sidebar",
            title: "米家",
            url: "panel",
            icon: null,
          },
        ],
      },
    ],
  };
  let reads = 0;
  let finishOpen: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", async () => {
    reads++;
    if (reads === 2)
      return new Promise<Response>((resolve) => {
        finishOpen = resolve;
      });
    return Response.json(payload);
  });
  const view = render(<CodeWorkbenchFrame />);
  await waitFor(() => expect(reads).toBe(1));
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: {
        type: "kenfutwork:code-open-plugin",
        pluginId: "bundled__mihome",
        entryId: "devices",
      },
    }),
  );
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(reads).toBe(3));
  if (!finishOpen) throw new Error("未建立插件打开目录请求");
  view.rerender(
    <CodeWorkbenchFrame availableModes={["code", "design", "flow"]} />,
  );
  finishOpen(Response.json(payload));
  expect(await screen.findByTitle("米家")).not.toBeNull();
});

it("Code宿主退出后，晚到的打开读取不再补发请求或打开面板", async () => {
  let reads = 0;
  let finishOpen: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", async () => {
    reads++;
    if (reads === 2)
      return new Promise<Response>((resolve) => {
        finishOpen = resolve;
      });
    return Response.json({ plugins: [] });
  });
  const view = render(<CodeWorkbenchFrame />);
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: {
        type: "kenfutwork:code-open-plugin",
        pluginId: "bundled__mihome",
        entryId: "devices",
      },
    }),
  );
  await waitFor(() => expect(reads).toBe(2));
  view.unmount();
  if (!finishOpen) throw new Error("未建立插件打开目录请求");
  await act(async () => {
    finishOpen?.(Response.json({ plugins: [] }));
  });
  expect(reads).toBe(2);
  expect(screen.queryByTitle("米家")).toBeNull();
});

it("壳层挂载前由父页盖一张启动加载屏，收到本壳的 code-mounted 才撤下", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ plugins: [] }));
  const view = render(<CodeWorkbenchFrame />);
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  const loader = () => view.container.querySelector('[aria-busy="true"]');
  expect(loader(), "挂载信号前必须有一屏加载动画").not.toBeNull();

  const post = (source: Window | null) =>
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source,
        data: { type: "kenfutwork:code-mounted" },
      }),
    );
  // 别的窗口（含父页自己）冒充壳层发信号不算数
  post(window);
  post(null);
  expect(loader(), "非本壳的信号不得提前撤屏").not.toBeNull();

  post(frame.contentWindow);
  await waitFor(() => expect(loader()).toBeNull());
});

it("Code 壳主题变更同步到父页统一持久化，拒绝其它来源", async () => {
  render(<CodeWorkbenchFrame />);
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "https://untrusted.example",
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-theme-change", theme: "zai-dark" },
    }),
  );
  expect(themeHost.setTheme).not.toHaveBeenCalled();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-theme-change", theme: "zai-dark" },
    }),
  );
  expect(themeHost.setTheme).toHaveBeenCalledWith("dark");
});

it("Work 保存由父页统一交付，同 saveId 并发重放只落盘一次", async () => {
  themeHost.triggerDownload.mockResolvedValue(undefined);
  render(<CodeWorkbenchFrame />);
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("测试 Code 文档未创建");
  const post = vi.spyOn(frame.contentWindow, "postMessage");
  const data = {
    type: "kenfutwork:work-save",
    saveId: "save-1",
    fileName: "Book1.xlsx",
    mimeType: "application/octet-stream",
    bytes: new TextEncoder().encode("workbook").buffer,
  };
  for (let index = 0; index < 2; index += 1) {
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data,
      }),
    );
  }

  await waitFor(() =>
    expect(themeHost.triggerDownload).toHaveBeenCalledTimes(1),
  );
  const [name, blob, options] = themeHost.triggerDownload.mock.calls[0] as [
    string,
    Blob,
    { browserFallback: boolean },
  ];
  expect(name).toBe("Book1.xlsx");
  expect(await blob.text()).toBe("workbook");
  expect(options).toEqual({ browserFallback: false });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      {
        type: "kenfutwork:work-save-result",
        saveId: "save-1",
        ok: true,
        error: null,
      },
      window.location.origin,
    ),
  );
});

it("仅向当前 Code 文档发送宿主配置；bootstrap 带本地实例主人（侧栏显示用户而非连接使用），仍无接入令牌", async () => {
  render(<CodeWorkbenchFrame />);
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("测试 Code 文档未创建");
  const send = vi.spyOn(frame.contentWindow, "postMessage");
  expect(frame.src).not.toContain("connect=");
  for (const source of [window, null]) {
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source,
        data: { type: "kenfutwork:code-ready" },
      }),
    );
  }
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "https://untrusted.example",
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-ready" },
    }),
  );
  expect(send).not.toHaveBeenCalled();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-ready" },
    }),
  );
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "kenfutwork:code-bootstrap",
        apiBase: window.location.origin,
        // 本地实例主人（DEC-20 免账户）：id 即 instanceId，侧栏底部显示用户而不是「连接使用」
        user: { id: "instance", username: "local", displayName: "本地用户" },
      }),
      window.location.origin,
    ),
  );
  // 没有明确深链时由壳恢复窗口选择，父页仅同步可用工作方式；
  // 旧「code-navigate 换壳请求」已随契约删除——迟到的该消息被 schema 拒之门外。
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      {
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design"],
      },
      window.location.origin,
    ),
  );
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-navigate", mode: "design" },
    }),
  );
  const lost = vi.fn();
  window.addEventListener(LOCAL_ACCESS_LOST_EVENT, lost);
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: window,
      data: { type: "kenfutwork:code-access-lost" },
    }),
  );
  expect(lost).not.toHaveBeenCalled();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-access-lost" },
    }),
  );
  expect(lost).toHaveBeenCalledOnce();
  window.removeEventListener(LOCAL_ACCESS_LOST_EVENT, lost);
});

it("隐藏Code窗口继续bootstrap，恢复时同一文档收到活动状态与最新模式", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ plugins: [] }));
  const view = render(<CodeWorkbenchFrame active={false} />);
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("Code窗口缺失");
  const send = vi.spyOn(frame.contentWindow, "postMessage");
  const event = (data: unknown) =>
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data,
      }),
    );
  event({ type: "kenfutwork:code-ready" });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ type: "kenfutwork:code-bootstrap" }),
    window.location.origin,
  );
  expect(send).toHaveBeenCalledWith(
    { type: "kenfutwork:workspace-activity", active: false },
    window.location.origin,
  );
  // 模式变化（父页深链解析）在隐藏期间照常推送；恢复时补活动状态，不换文档。
  view.rerender(<CodeWorkbenchFrame active mode="design" />);
  expect(screen.getByTitle("Code 工作台")).toBe(frame);
  expect(send).toHaveBeenCalledWith(
    { type: "kenfutwork:workspace-activity", active: true },
    window.location.origin,
  );
  expect(send).toHaveBeenCalledWith(
    {
      type: "kenfutwork:workbench-navigation",
      availableModes: ["code", "design"],
      mode: "design",
    },
    window.location.origin,
  );
});

it("管理文档创建任务在壳 ready 后按 id 推送一次，重复渲染不重复建草稿", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ plugins: [] }));
  const request = {
    id: 1,
    prompt: "创建一个技能：\n",
    executionMode: "creative" as const,
  };
  const view = render(<CodeWorkbenchFrame newTaskRequest={request} />);
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("测试 Code 文档未创建");
  const send = vi.spyOn(frame.contentWindow, "postMessage");
  const taskPosts = () =>
    send.mock.calls.filter(
      ([message]) =>
        (message as { type?: unknown }).type === "kenfutwork:host-new-task",
    );
  // ready 之前不推：壳内监听器尚未就位，消息会丢。
  expect(taskPosts()).toHaveLength(0);
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-ready" },
    }),
  );
  await waitFor(() => expect(taskPosts()).toHaveLength(1));
  expect(taskPosts()[0]?.[0]).toEqual({
    type: "kenfutwork:host-new-task",
    prompt: "创建一个技能：\n",
    executionMode: "creative",
  });
  // 同一请求（id 不变）重复渲染不重复推送。
  view.rerender(
    <CodeWorkbenchFrame
      newTaskRequest={{
        id: 1,
        prompt: "创建一个技能：\n",
        executionMode: "creative",
      }}
    />,
  );
  expect(taskPosts()).toHaveLength(1);
  // 新请求按新 id 再推一次。
  view.rerender(
    <CodeWorkbenchFrame
      newTaskRequest={{
        id: 2,
        prompt: "创建一个插件：\n",
        executionMode: "creative",
      }}
    />,
  );
  await waitFor(() => expect(taskPosts()).toHaveLength(2));
  expect(taskPosts()[1]?.[0]).toEqual({
    type: "kenfutwork:host-new-task",
    prompt: "创建一个插件：\n",
    executionMode: "creative",
  });
});

it("Code插件面板切换到非活动工作区时保留同一iframe，返回后恢复原面板", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      plugins: [
        {
          id: "bundled__mihome",
          installed: true,
          enabled: true,
          scope: "shared",
          ui: [
            {
              id: "devices",
              slot: "sidebar",
              title: "米家",
              url: "panel",
              icon: null,
            },
          ],
        },
      ],
    }),
  );
  const view = render(<CodeWorkbenchFrame active />);
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: {
        type: "kenfutwork:code-open-plugin",
        pluginId: "bundled__mihome",
        entryId: "devices",
      },
    }),
  );
  const panel = await screen.findByTitle("米家");
  view.rerender(<CodeWorkbenchFrame active={false} />);
  expect(screen.getByTitle("米家")).toBe(panel);
  expect(screen.queryByRole("dialog", { name: "米家" })).toBeNull();
  view.rerender(<CodeWorkbenchFrame active />);
  expect(await screen.findByRole("dialog", { name: "米家" })).not.toBeNull();
  expect(screen.getByTitle("米家")).toBe(panel);
});
