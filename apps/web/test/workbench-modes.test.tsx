import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Workbench } from "../src/components/workbench/workbench";
import {
  LocalInstanceBoundary,
  LocalInstanceProvider,
} from "../src/lib/local-instance-context";
import { PLUGIN_INVENTORY_CHANGED_EVENT } from "../src/lib/plugin-panels";

const navigation = vi.hoisted(() => ({
  query: "",
  replace: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(navigation.query),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
  navigation.query = "";
});

/**
 * 主区懒加载块（CanvasWorkbench / CodeWorkbenchFrame 首包）在满负载的**全量并发**里
 * 可能明显慢于 Testing Library 默认 1s，属已登记的「首包懒加载超时」家族；显式放宽
 * 等待（15s，留出 vitest 单测 20s 上限的余量），让本文件在全量里也稳定
 * （隔离复跑一直是绿的）。
 */
const LAZY = { timeout: 15_000 } as const;

function installFixture(
  flowInstalled = false,
  flowEnabled = false,
  flowStatus?: Promise<Response>,
  pluginEnabled = true,
  plugins?: Array<{ name: string; installed: boolean; enabled: boolean }>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const path = String(input);
      let result: unknown = {};
      if (path.endsWith("/api/instance"))
        result = {
          instanceId: "11111111-1111-4111-8111-111111111111",
          dataDir: "/data",
        };
      if (path.includes("/api/projects"))
        result = {
          projects: [
            {
              id: "project",
              name: "设计项目",
              kind: "design",
              primaryCanvas: { id: "canvas" },
              createdAt: "2026-10-04T00:00:00Z",
              updatedAt: "2026-10-04T00:00:00Z",
            },
          ],
        };
      if (path.endsWith("/api/plugins"))
        result = {
          plugins:
            plugins ??
            (flowInstalled
              ? [
                  {
                    name: "kenfutwork-flow",
                    installed: true,
                    enabled: pluginEnabled,
                  },
                ]
              : []),
        };
      if (path.endsWith("/api/flow/host/status"))
        if (flowStatus) return flowStatus.then((response) => response.clone());
      if (path.endsWith("/api/flow/host/status"))
        result = {
          enabled: flowEnabled,
          frontendUrl: flowEnabled ? "https://flow.example.test" : null,
          reasons: [],
        };
      if (path.endsWith("/api/models")) result = { models: [] };
      if (path.endsWith("/api/instance/settings"))
        result = { settings: { commands: [] } };
      return Response.json(result);
    }),
  );
}

it("Code默认主区仍是原iframe，可信原菜单Design请求同时更新URL导航", async () => {
  installFixture();
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  const frame = (await screen.findByTitle(
    "Code 工作台",
    {},
    LAZY,
  )) as HTMLIFrameElement;
  expect(frame.getAttribute("src")).toBe("/code-ui/index.html");
  expect(screen.queryByRole("radiogroup", { name: "模式切换" })).toBeNull();
  // 懒加载首包与消息监听注册之间有天然时序差：重发同一事件直到导航被触发
  // （消息幂等，重发无害），避免满负载全量并发下的「事件早于监听」假红。
  await waitFor(
    () => {
      fireEvent(
        window,
        new MessageEvent("message", {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: { type: "kenfutwork:code-navigate", mode: "design" },
        }),
      );
      expect(navigation.replace).toHaveBeenCalledWith("/workbench?mode=design");
    },
    { timeout: 10_000 },
  );
});

it("已安装但停用的Flow不显示模式入口，也不挂载工作流文档", async () => {
  navigation.query = "mode=design";
  installFixture(true, true, undefined, false);
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  await screen.findByTitle("设计项目 画布", {}, LAZY);
  expect(screen.queryByRole("radio", { name: "Flow" })).toBeNull();
  expect(screen.queryByTitle("Flow 工作流画布")).toBeNull();
});

it.each([false, true])(
  "同名Flow来源并存时按已安装且启用候选显示入口，不受来源顺序影响（reverse=%s）",
  async (reverse) => {
    navigation.query = "mode=flow";
    const plugins = [
      { name: "kenfutwork-flow", installed: true, enabled: false },
      { name: "kenfutwork-flow", installed: true, enabled: true },
    ];
    installFixture(
      true,
      true,
      undefined,
      true,
      reverse ? plugins.reverse() : plugins,
    );
    render(
      <LocalInstanceProvider>
        <LocalInstanceBoundary>
          <Workbench />
        </LocalInstanceBoundary>
      </LocalInstanceProvider>,
    );
    expect(
      await screen.findByTitle("Flow 工作流画布", {}, LAZY),
    ).not.toBeNull();
    expect(
      screen.getByRole("radio", { name: "Flow" }).getAttribute("aria-checked"),
    ).toBe("true");
  },
);

it("未安装来源的enabled不能和另一停用来源拼成可用Flow", async () => {
  navigation.query = "mode=design";
  installFixture(true, true, undefined, true, [
    { name: "kenfutwork-flow", installed: true, enabled: false },
    { name: "kenfutwork-flow", installed: false, enabled: true },
  ]);
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  await screen.findByTitle("设计项目 画布", {}, LAZY);
  expect(screen.queryByRole("radio", { name: "Flow" })).toBeNull();
});

it("实例插件启停后Flow模式入口立即按真实库存刷新，无需离开工作区", async () => {
  navigation.query = "mode=design";
  const plugin = { name: "kenfutwork-flow", installed: true, enabled: false };
  const plugins = [plugin];
  installFixture(true, true, undefined, false, plugins);
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  await screen.findByTitle("设计项目 画布", {}, LAZY);
  expect(screen.queryByRole("radio", { name: "Flow" })).toBeNull();
  plugin.enabled = true;
  fireEvent(window, new Event(PLUGIN_INVENTORY_CHANGED_EVENT));
  expect(await screen.findByRole("radio", { name: "Flow" })).not.toBeNull();
  plugin.enabled = false;
  fireEvent(window, new Event(PLUGIN_INVENTORY_CHANGED_EVENT));
  await waitFor(() =>
    expect(screen.queryByRole("radio", { name: "Flow" })).toBeNull(),
  );
  expect(screen.getByTitle("设计项目 画布")).not.toBeNull();
});

it("Code的顶部模式能力来自真实宿主库存，Flow停用后同步移除且拒绝迟到导航", async () => {
  const plugin = { name: "kenfutwork-flow", installed: true, enabled: true };
  installFixture(true, true, undefined, true, [plugin]);
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  const frame = (await screen.findByTitle(
    "Code 工作台",
    {},
    LAZY,
  )) as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("Code文档未创建");
  const send = vi.spyOn(frame.contentWindow, "postMessage");
  const message = (data: unknown) =>
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data,
      }),
    );
  await waitFor(() => {
    message({ type: "kenfutwork:code-ready" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "kenfutwork:code-bootstrap",
        workbenchModes: ["code", "design", "flow"],
      }),
      window.location.origin,
    );
  });
  message({ type: "kenfutwork:code-navigate", mode: "flow" });
  expect(navigation.replace).toHaveBeenCalledWith("/workbench?mode=flow");
  navigation.replace.mockClear();
  send.mockClear();
  plugin.enabled = false;
  fireEvent(window, new Event(PLUGIN_INVENTORY_CHANGED_EVENT));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      {
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design"],
      },
      window.location.origin,
    ),
  );
  message({ type: "kenfutwork:code-navigate", mode: "flow" });
  expect(navigation.replace).not.toHaveBeenCalled();
});

it("Flow可用态读取在飞时保留已访问的Code文档，落定后按需挂Flow且切回不重建", async () => {
  let settle!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  installFixture(true, true, pending);
  const view = render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  const code = await screen.findByTitle("Code 工作台", {}, LAZY);
  navigation.query = "mode=flow";
  view.rerender(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  expect(screen.getByTitle("Code 工作台")).toBe(code);
  expect(screen.queryByTitle("Flow 工作流画布")).toBeNull();
  await act(async () => {
    settle(
      Response.json({
        enabled: true,
        frontendUrl: "https://flow.example.test",
        reasons: [],
      }),
    );
  });
  const flow = await screen.findByTitle("Flow 工作流画布", {}, LAZY);
  navigation.query = "";
  view.rerender(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  expect(screen.getByTitle("Code 工作台")).toBe(code);
  expect(screen.getByTitle("Flow 工作流画布")).toBe(flow);
});

it("URL Design始终画布，侧栏折返不替换主区；Flow未装时无入口，Code切换更新URL", async () => {
  navigation.query = "mode=design";
  installFixture();
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  const canvas = await screen.findByTitle("设计项目 画布", {}, LAZY);
  expect(canvas.getAttribute("src")).toBe("/canvas?id=canvas");
  expect(
    screen.getByRole("radio", { name: "Design" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.queryByTitle("Code 工作台")).toBeNull();
  expect(screen.queryByRole("radio", { name: "Flow" })).toBeNull();
  expect(screen.queryByRole("button", { name: "展开侧栏" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
  expect(screen.getByRole("button", { name: "展开侧栏" })).not.toBeNull();
  expect(screen.getByTitle("设计项目 画布").getAttribute("src")).toBe(
    "/canvas?id=canvas",
  );
  fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
  fireEvent.click(screen.getByRole("radio", { name: "Code" }));
  expect(navigation.replace).toHaveBeenCalledWith("/workbench");
});

it.each([false, true])(
  "裸Flow URL不能构造未安装或未适配插件入口（installed=%s）",
  async (installed) => {
    navigation.query = "mode=flow";
    installFixture(installed);
    render(
      <LocalInstanceProvider>
        <LocalInstanceBoundary>
          <Workbench />
        </LocalInstanceBoundary>
      </LocalInstanceProvider>,
    );
    expect(await screen.findByTitle("Code 工作台", {}, LAZY)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Flow" })).toBeNull();
  },
);

it("Flow URL只有插件安装且宿主配齐时挂工作流画布，Code切换仍回原宿主", async () => {
  navigation.query = "mode=flow";
  installFixture(true, true);
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  const flow = await screen.findByTitle("Flow 工作流画布", {}, LAZY);
  expect(flow.getAttribute("src")).toContain("https://flow.example.test");
  expect(screen.queryByTitle("Code 工作台")).toBeNull();
  expect(
    screen.getByRole("radio", { name: "Flow" }).getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Code" }));
  expect(navigation.replace).toHaveBeenCalledWith("/workbench");
});

it("状态探针慢于插件探针：?mode=flow 不被中间态改写成 design（真机竞态回归）", async () => {
  navigation.query = "mode=flow";
  // 状态探针会分别被外层判定与工作台守卫各拉一次：两条都要能放行。
  const statusResolvers: Array<(response: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/flow/host/status")) {
        return await new Promise<Response>((resolve) => {
          statusResolvers.push(resolve);
        });
      }
      if (path.endsWith("/api/instance"))
        return Response.json({
          instanceId: "11111111-1111-4111-8111-111111111111",
          dataDir: "/data",
        });
      if (path.includes("/api/projects"))
        return Response.json({
          projects: [
            {
              id: "project",
              name: "设计项目",
              kind: "design",
              primaryCanvas: { id: "canvas" },
              createdAt: "2026-10-04T00:00:00Z",
              updatedAt: "2026-10-04T00:00:00Z",
            },
          ],
        });
      if (path.endsWith("/api/plugins"))
        return Response.json({
          plugins: [
            { name: "kenfutwork-flow", installed: true, enabled: true },
          ],
        });
      if (path.endsWith("/api/models")) return Response.json({ models: [] });
      if (path.endsWith("/api/instance/settings"))
        return Response.json({ settings: { commands: [] } });
      return Response.json({});
    }),
  );
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  // 插件探针已答、状态探针未答：这一拍里**不能**发生 design 改写
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(navigation.replace).not.toHaveBeenCalledWith("/workbench?mode=design");
  // 状态落定（配齐）后照常挂上工作流画布：逐轮放行后续挂起的状态探针
  // （外层判定放行后，工作台守卫自己还会再拉一次）——满负载下探针数不定，循环到画布出现。
  const ready = () =>
    Response.json({
      enabled: true,
      frontendUrl: "https://flow.example.test",
      reasons: [],
    });
  const deadlineAt = Date.now() + 10_000;
  while (Date.now() < deadlineAt) {
    await act(async () => {
      for (const resolve of statusResolvers.splice(0)) resolve(ready());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    if (screen.queryByTitle("Flow 工作流画布")) break;
  }
  expect(await screen.findByTitle("Flow 工作流画布", {}, LAZY)).toBeTruthy();
});

it("已访问的Code与Design文档在连续切换后保持同一iframe及侧栏状态，未访问工作区不预载", async () => {
  installFixture();
  const page = (
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>
  );
  const view = render(page);
  const code = await screen.findByTitle("Code 工作台", {}, LAZY);
  expect(screen.queryByTitle("设计项目 画布")).toBeNull();
  navigation.query = "mode=design";
  view.rerender(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  const canvas = await screen.findByTitle("设计项目 画布", {}, LAZY);
  expect(screen.getByTitle("Code 工作台")).toBe(code);
  expect(code.closest("[data-workbench-mode]")?.hasAttribute("hidden")).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
  navigation.query = "";
  view.rerender(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  expect(await screen.findByTitle("Code 工作台", {}, LAZY)).toBe(code);
  expect(screen.getByTitle("设计项目 画布")).toBe(canvas);
  navigation.query = "mode=design";
  view.rerender(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  expect(await screen.findByTitle("设计项目 画布", {}, LAZY)).toBe(canvas);
  expect(screen.getByRole("button", { name: "展开侧栏" })).not.toBeNull();
});

it("Flow与Design持续挂载时按各自真实kind读取项目，Flow不借Design项目列表", async () => {
  navigation.query = "mode=flow";
  installFixture(true, true);
  const fetchSpy = fetch as ReturnType<typeof vi.fn>;
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  await screen.findByTitle("Flow 工作流画布", {}, LAZY);
  await waitFor(() =>
    expect(
      fetchSpy.mock.calls.some(([url]) =>
        String(url).includes("/api/projects?kind=flow"),
      ),
    ).toBe(true),
  );
  expect(
    fetchSpy.mock.calls.some(([url]) =>
      String(url).includes("/api/projects?kind=design"),
    ),
  ).toBe(false);
});

it("持续挂载的画布只接受自身窗口且真实kind匹配的项目消息，Design创建不刷新后台Flow", async () => {
  navigation.query = "mode=design";
  installFixture(true, true);
  const baseFetch = fetch;
  const project = (id: string, kind: "design" | "flow") => ({
    id,
    kind,
    name: id,
    primaryCanvas: { id: `${id}-canvas` },
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
  });
  const fetchSpy = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/api/projects?kind=design"))
        return Response.json({
          projects: [
            project("design-first", "design"),
            project("design-new", "design"),
          ],
        });
      if (path.includes("/api/projects?kind=flow"))
        return Response.json({ projects: [project("flow-first", "flow")] });
      return baseFetch(input, init);
    },
  );
  vi.stubGlobal("fetch", fetchSpy);
  const view = render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  const canvas = (await screen.findByTitle(
    "design-first 画布",
    {},
    LAZY,
  )) as HTMLIFrameElement;
  navigation.query = "mode=flow";
  view.rerender(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  await screen.findByTitle("Flow 工作流画布", {}, LAZY);
  const flowReads = () =>
    fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/api/projects?kind=flow"),
    ).length;
  const before = flowReads();
  const send = (
    projectId: string,
    source: MessageEventSource | null,
    origin = window.location.origin,
  ) =>
    fireEvent(
      window,
      new MessageEvent("message", {
        source,
        origin,
        data: { type: "workbench:project-created", projectId },
      }),
    );
  send("design-new", canvas.contentWindow);
  await screen.findByTitle("design-new 画布", {}, LAZY);
  expect(flowReads()).toBe(before);
  const current = screen.getByTitle("design-new 画布") as HTMLIFrameElement;
  await act(async () => {
    send("design-first", window);
    send("design-first", current.contentWindow, "https://untrusted.example");
    send("flow-first", current.contentWindow);
    await Promise.resolve();
  });
  expect(screen.getByTitle("design-new 画布")).toBe(current);
  expect(flowReads()).toBe(before);
});

it("Design插件面板切换到Code后隐藏且保留iframe，返回恢复同一面板", async () => {
  navigation.query = "mode=design";
  installFixture();
  const baseFetch = fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/api/plugins")
        ? Response.json({
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
          })
        : baseFetch(input, init),
  );
  const view = render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "米家" }, LAZY));
  const panel = await screen.findByTitle("米家");
  navigation.query = "";
  view.rerender(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  await screen.findByTitle("Code 工作台", {}, LAZY);
  expect(screen.queryByRole("dialog", { name: "米家" })).toBeNull();
  expect(screen.getByTitle("米家")).toBe(panel);
  navigation.query = "mode=design";
  view.rerender(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  expect(await screen.findByRole("dialog", { name: "米家" })).not.toBeNull();
  expect(screen.getByTitle("米家")).toBe(panel);
});

it("Design打开MCP使用独立原管理文档，可信关闭回到同一画布且不切换模式", async () => {
  navigation.query = "mode=design";
  installFixture();
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  const canvas = (await screen.findByTitle(
    "设计项目 画布",
    {},
    LAZY,
  )) as HTMLIFrameElement;
  fireEvent.click(screen.getByRole("button", { name: "MCP" }));
  const manager = (await screen.findByTitle("管理设置")) as HTMLIFrameElement;
  expect(manager.getAttribute("src")).toBe(
    "/code-ui/index.html?document=management",
  );
  if (!manager.contentWindow) throw new Error("管理文档未创建");
  const send = vi.spyOn(manager.contentWindow, "postMessage");
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: manager.contentWindow,
      data: { type: "kenfutwork:code-ready" },
    }),
  );
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "kenfutwork:code-bootstrap",
      management: { page: "settings", section: "mcp" },
    }),
    window.location.origin,
  );
  expect(canvas.closest("[data-workbench-mode]")?.hasAttribute("inert")).toBe(
    true,
  );
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: window,
      data: { type: "kenfutwork:management-close" },
    }),
  );
  expect(screen.getByTitle("管理设置")).toBe(manager);
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: manager.contentWindow,
      data: { type: "kenfutwork:management-close" },
    }),
  );
  expect(screen.queryByTitle("管理设置")).toBeNull();
  expect(screen.getByTitle("设计项目 画布")).toBe(canvas);
  expect(canvas.closest("[data-workbench-mode]")?.hasAttribute("inert")).toBe(
    false,
  );
  expect(navigation.replace).not.toHaveBeenCalled();
});

it("Code可信模型管理请求打开同一独立文档，拒绝伪造和无效目标，关闭保留Codeiframe", async () => {
  installFixture();
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  const code = (await screen.findByTitle(
    "Code 工作台",
    {},
    LAZY,
  )) as HTMLIFrameElement;
  const open = {
    type: "kenfutwork:open-management",
    target: {
      page: "settings",
      section: "modelProvider",
      modelProviderId: "provider:glm",
    },
  };
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: window,
      data: open,
    }),
  );
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "https://untrusted.example",
      source: code.contentWindow,
      data: open,
    }),
  );
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: code.contentWindow,
      data: { ...open, target: { page: "settings", section: "invalid" } },
    }),
  );
  expect(screen.queryByTitle("管理设置")).toBeNull();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: code.contentWindow,
      data: open,
    }),
  );
  const manager = (await screen.findByTitle("管理设置")) as HTMLIFrameElement;
  expect(screen.getByTitle("Code 工作台")).toBe(code);
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: manager.contentWindow,
      data: { type: "kenfutwork:management-close" },
    }),
  );
  expect(screen.queryByTitle("管理设置")).toBeNull();
  expect(screen.getByTitle("Code 工作台")).toBe(code);
  expect(navigation.replace).not.toHaveBeenCalled();
});

it("管理文档加载中或失败时宿主仍能关闭并恢复原Codeiframe", async () => {
  installFixture();
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  const code = (await screen.findByTitle(
    "Code 工作台",
    {},
    LAZY,
  )) as HTMLIFrameElement;
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: code.contentWindow,
      data: {
        type: "kenfutwork:open-management",
        target: { page: "settings", section: "mcp" },
      },
    }),
  );
  const manager = await screen.findByTitle("管理设置");
  fireEvent.error(manager);
  fireEvent.click(screen.getByRole("button", { name: "关闭管理页" }));
  expect(screen.queryByTitle("管理设置")).toBeNull();
  expect(screen.getByTitle("Code 工作台")).toBe(code);
  expect(code.hasAttribute("inert")).toBe(false);
});

it.each([
  { name: "技能", target: { page: "settings", section: "skill" } },
  { name: "插件", target: { page: "plugins" } },
])(
  "Design的$name入口进入同一个原管理文档并保留画布",
  async ({ name, target }) => {
    navigation.query = "mode=design";
    installFixture();
    render(
      <LocalInstanceProvider>
        <LocalInstanceBoundary>
          <Workbench />
        </LocalInstanceBoundary>
      </LocalInstanceProvider>,
    );
    const canvas = await screen.findByTitle("设计项目 画布", {}, LAZY);
    fireEvent.click(screen.getByRole("button", { name }));
    const manager = (await screen.findByTitle("管理设置")) as HTMLIFrameElement;
    if (!manager.contentWindow) throw new Error("管理文档未创建");
    const send = vi.spyOn(manager.contentWindow, "postMessage");
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source: manager.contentWindow,
        data: { type: "kenfutwork:code-ready" },
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ management: target }),
      window.location.origin,
    );
    expect(screen.getByTitle("设计项目 画布")).toBe(canvas);
  },
);
