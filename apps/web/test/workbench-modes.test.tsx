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

function installFixture(flowInstalled = false, flowEnabled = false) {
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
          plugins: flowInstalled
            ? [{ name: "kenfutwork-flow", installed: true }]
            : [],
        };
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
  // 懒加载首包与消息监听注册之间有天然时序差；重发同一事件直到导航被触发（消息幂等，
  // 重发无害）。每轮重新查一次活着的 iframe：CI 满负载下 Workbench 会重挂 frame，
  // 攥着已卸载元素的 contentWindow 发消息会被 `event.source !== frame.current?.contentWindow`
  // 静默丢弃，看起来就像「监听没注册」。
  await waitFor(
    () => {
      const live = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
      fireEvent(
        window,
        new MessageEvent("message", {
          origin: window.location.origin,
          source: live.contentWindow,
          data: { type: "kenfutwork:code-navigate", mode: "design" },
        }),
      );
      expect(navigation.replace).toHaveBeenCalledWith("/workbench?mode=design");
    },
    { timeout: 10_000 },
  );
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
          plugins: [{ name: "kenfutwork-flow", installed: true }],
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
