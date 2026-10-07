import {
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
  const frame = (await screen.findByTitle("Code 工作台")) as HTMLIFrameElement;
  expect(frame.getAttribute("src")).toBe("/code-ui/index.html");
  expect(screen.queryByRole("radiogroup", { name: "模式切换" })).toBeNull();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-navigate", mode: "design" },
    }),
  );
  await waitFor(() =>
    expect(navigation.replace).toHaveBeenCalledWith("/workbench?mode=design"),
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
  const canvas = await screen.findByTitle("设计项目 画布");
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
    expect(await screen.findByTitle("Code 工作台")).toBeTruthy();
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
  const flow = await screen.findByTitle("Flow 工作流画布");
  expect(flow.getAttribute("src")).toContain("https://flow.example.test");
  expect(screen.queryByTitle("Code 工作台")).toBeNull();
  expect(
    screen.getByRole("radio", { name: "Flow" }).getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Code" }));
  expect(navigation.replace).toHaveBeenCalledWith("/workbench");
});
