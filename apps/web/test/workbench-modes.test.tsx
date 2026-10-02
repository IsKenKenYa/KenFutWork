import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Workbench } from "../src/components/workbench/workbench";
import { AuthProvider } from "../src/lib/auth-context";

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

function renderWorkbench() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            profile: {
              id: "actor",
              email: "dev@example.test",
              displayName: "开发者",
            },
          }),
        ),
    ),
  );
  return render(
    <AuthProvider>
      <Workbench />
    </AuthProvider>,
  );
}

it("工作台默认挂完整原 Code 文档；原菜单的 Design 请求回到客户端模式导航", async () => {
  renderWorkbench();
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

it("Design 保留项目侧栏与画布主区，收起或展开侧栏后仍是原画布", async () => {
  navigation.query = "mode=design";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      const profile = {
        id: "actor",
        email: "dev@example.test",
        displayName: "开发者",
      };
      let result: unknown = {};
      if (path.endsWith("/api/viewer")) result = { profile };
      if (path.includes("/api/projects"))
        result = {
          projects: [
            {
              id: "project",
              name: "设计项目",
              kind: "design",
              primaryCanvas: { id: "canvas" },
            },
          ],
        };
      if (path.endsWith("/api/plugins")) result = { plugins: [] };
      if (path.endsWith("/api/models")) result = { models: [] };
      if (path.endsWith("/api/settings"))
        result = { settings: { commands: [] } };
      return new Response(JSON.stringify(result));
    }),
  );
  render(
    <AuthProvider>
      <Workbench />
    </AuthProvider>,
  );
  const canvas = await screen.findByTitle(
    "设计项目 画布",
    {},
    { timeout: 20_000 },
  );
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
