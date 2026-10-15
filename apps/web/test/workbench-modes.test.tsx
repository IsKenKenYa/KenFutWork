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
 * 主区懒加载块（CodeWorkbenchFrame 首包）在满负载的**全量并发**里可能明显慢于
 * Testing Library 默认 1s，属已登记的「首包懒加载超时」家族；显式放宽等待
 * （15s，留出 vitest 单测 20s 上限的余量）。
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
      if (path.endsWith("/api/plugins"))
        result = {
          plugins: (
            plugins ??
            (flowInstalled
              ? [
                  {
                    name: "kenfutwork-flow",
                    installed: true,
                    enabled: pluginEnabled,
                  },
                ]
              : [])
          ).map((plugin) => ({ ...plugin, id: plugin.name, ui: [] })),
        };
      if (path.endsWith("/api/flow/host/status")) {
        if (flowStatus) return flowStatus.then((response) => response.clone());
        result = {
          enabled: flowEnabled,
          frontendUrl: flowEnabled ? "https://flow.example.test" : null,
          reasons: [],
        };
      }
      if (path.endsWith("/api/models")) result = { models: [] };
      if (path.endsWith("/api/instance/settings"))
        result = { settings: { commands: [] } };
      return Response.json(result);
    }),
  );
}

function host() {
  return (
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Workbench />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>
  );
}

async function renderCodeFrame() {
  render(host());
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
  message({ type: "kenfutwork:code-ready" });
  return { frame, send, message };
}

it("工作台恒渲染Code壳：深链design也不换壳，mode经导航消息推给壳且URL参数一次性消费", async () => {
  installFixture();
  navigation.query = "mode=design";
  render(host());
  const frame = await screen.findByTitle("Code 工作台", {}, LAZY);
  // 融合后没有旧画布工作台壳：主区只有 Code 壳一个 iframe（外加懒加载的管理文档不存在）。
  expect(screen.queryByTitle("设计项目 画布")).toBeNull();
  expect((frame as HTMLIFrameElement).getAttribute("src")).toBe(
    "/code-ui/index.html",
  );
  // URL 深链参数一次性消费（strip），不参与后续渲染。
  await waitFor(() =>
    expect(navigation.replace).toHaveBeenCalledWith("/workbench"),
  );
});

it("深链design向壳推mode=design；无flow插件时availableModes只有code/design", async () => {
  installFixture();
  navigation.query = "mode=design";
  const { send } = await renderCodeFrame();
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith(
      {
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design"],
        mode: "design",
      },
      window.location.origin,
    );
  });
});

it("刷新没有深链时只同步可用方式，让壳恢复当前窗口的选择", async () => {
  installFixture();
  const { send } = await renderCodeFrame();
  const initial = send.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === "kenfutwork:workbench-navigation");
  expect(initial.length).toBeGreaterThan(0);
  expect(initial.every((message) => !("mode" in message))).toBe(true);
});

it("明确Code深链仍推送Code，覆盖壳先前的界面选择", async () => {
  installFixture();
  navigation.query = "mode=code";
  const { send } = await renderCodeFrame();
  expect(send).toHaveBeenCalledWith(
    {
      type: "kenfutwork:workbench-navigation",
      availableModes: ["code", "design"],
      mode: "code",
    },
    window.location.origin,
  );
});

it("flow可用时availableModes带flow；插件停用后库存事件即时收口并保持当前mode", async () => {
  const plugin = { name: "kenfutwork-flow", installed: true, enabled: true };
  installFixture(true, true, undefined, true, [plugin]);
  const { send } = await renderCodeFrame();
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design", "flow"],
      }),
      window.location.origin,
    );
  });
  const initialNavigation = send.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === "kenfutwork:workbench-navigation");
  expect(initialNavigation.filter((message) => "mode" in message)).toHaveLength(
    0,
  );
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
  expect(
    send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "kenfutwork:workbench-navigation")
      .every((message) => !("mode" in message)),
  ).toBe(true);
});

it("同一Code文档仅初始与明确外部模式变更带mode，能力更新不重推旧mode", async () => {
  installFixture();
  const tree = (mode: "code" | "design", flow = false) => (
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <CodeWorkbenchFrame
          mode={mode}
          availableModes={
            flow ? ["code", "design", "flow"] : ["code", "design"]
          }
        />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>
  );
  const view = render(tree("code"));
  const frame = (await screen.findByTitle(
    "Code 工作台",
    {},
    LAZY,
  )) as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("Code文档未创建");
  const send = vi.spyOn(frame.contentWindow, "postMessage");
  fireEvent(
    window,
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: "kenfutwork:code-ready" },
    }),
  );
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      {
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design"],
        mode: "code",
      },
      window.location.origin,
    ),
  );
  send.mockClear();
  view.rerender(tree("code", true));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      {
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design", "flow"],
      },
      window.location.origin,
    ),
  );
  expect(
    send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "kenfutwork:workbench-navigation")
      .every((message) => !("mode" in message)),
  ).toBe(true);
  send.mockClear();
  view.rerender(tree("design", true));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      {
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design", "flow"],
        mode: "design",
      },
      window.location.origin,
    ),
  );
  expect(screen.getByTitle("Code 工作台")).toBe(frame);
});

it("状态探针慢于插件探针：?mode=flow 不被中间态改写成 design，落定后按真实可用性推送", async () => {
  let settle!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  installFixture(true, true, pending);
  navigation.query = "mode=flow";
  const { send } = await renderCodeFrame();
  // 探针在飞：入口不出现（availableModes 不含 flow）、模式按 code 推——
  // 不猜「可用」，也不提前回落 design（那会把深链一秒弹去 Design 画布）。
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith(
      {
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design"],
        mode: "code",
      },
      window.location.origin,
    );
  });
  send.mockClear();
  await act(async () => {
    settle(
      Response.json({
        enabled: true,
        frontendUrl: "https://flow.example.test",
        reasons: [],
      }),
    );
  });
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      {
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design", "flow"],
        mode: "flow",
      },
      window.location.origin,
    ),
  );
});

it("深链flow但宿主适配层未配齐时回落design（不放空壳）", async () => {
  installFixture(true, false);
  navigation.query = "mode=flow";
  const { send } = await renderCodeFrame();
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design"],
        mode: "design",
      }),
      window.location.origin,
    );
  });
});

it("Code可信模型管理请求打开同一独立文档，拒绝伪造和无效目标，关闭保留Codeiframe", async () => {
  installFixture();
  const { frame } = await renderCodeFrame();
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
      source: frame.contentWindow,
      data: open,
    }),
  );
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { ...open, target: { page: "settings", section: "invalid" } },
    }),
  );
  // 预加载契约：打开前管理文档已在但 hidden，打开后可见。
  expect(
    (screen.getByTitle("管理设置") as HTMLIFrameElement).hasAttribute("hidden"),
  ).toBe(true);
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: open,
    }),
  );
  const manager = (await screen.findByTitle("管理设置")) as HTMLIFrameElement;
  expect(manager.hasAttribute("hidden")).toBe(false);
  expect(screen.getByTitle("Code 工作台")).toBe(frame);
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: manager.contentWindow,
      data: { type: "kenfutwork:management-close" },
    }),
  );
  // keep-alive：关闭后管理文档常驻但隐藏（下次打开不重载）
  expect(
    (screen.getByTitle("管理设置") as HTMLIFrameElement).hasAttribute("hidden"),
  ).toBe(true);
  expect(screen.getByTitle("Code 工作台")).toBe(frame);
});

it("管理文档加载中或失败时宿主仍能关闭并恢复原Codeiframe", async () => {
  installFixture();
  const { frame, message } = await renderCodeFrame();
  message({
    type: "kenfutwork:open-management",
    target: { page: "settings" },
  });
  const manager = (await screen.findByTitle(
    "管理设置",
    {},
    LAZY,
  )) as HTMLIFrameElement;
  // 关闭消息必须来自管理文档自身（别的窗口发同款消息不得顶掉它）。
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: manager.contentWindow,
      data: { type: "kenfutwork:management-close" },
    }),
  );
  expect(
    (screen.getByTitle("管理设置") as HTMLIFrameElement).hasAttribute("hidden"),
  ).toBe(true);
  expect(screen.getByTitle("Code 工作台")).toBe(frame);
});

it("旧模型入口打开同一管理文档并定位模型设置，重复打开不创建第二个页面", async () => {
  installFixture();
  render(host());
  const manager = (await screen.findByTitle(
    "管理设置",
    {},
    LAZY,
  )) as HTMLIFrameElement;
  expect(manager.hidden).toBe(true);
  if (!manager.contentWindow) throw new Error("管理文档未创建");
  const send = vi.spyOn(manager.contentWindow, "postMessage");
  act(() => window.dispatchEvent(new Event("kenfutwork:open-model-settings")));
  await waitFor(() => expect(manager.hidden).toBe(false));
  expect(send).toHaveBeenCalledWith(
    {
      type: "kenfutwork:management-target",
      target: { page: "settings", section: "modelProvider" },
    },
    window.location.origin,
  );
  act(() => window.dispatchEvent(new Event("kenfutwork:open-model-settings")));
  expect(screen.getAllByTitle("管理设置")).toHaveLength(1);
  expect(screen.getByTitle("管理设置")).toBe(manager);
});
