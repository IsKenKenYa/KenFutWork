import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TID_PROJECT_ADD } from "../../../packages/zcode-shared/dist/index.js";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { SharedProjectNavigationProvider } from "../src/components/workbench/zcode/host/SharedProjectNavigation";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { Root } from "@zui/Root";
import { TabStoreProvider } from "@zui/store/TabStoreProvider";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { bindCodeWorkspaceServices } from "../src/components/workbench/zcode/host/workspaceServices";
import {
  installCodeRootBrowser,
  restoreCodeRootBrowser,
} from "./setup/code-root-host-browser";
import {
  createCodeRootHostFetch,
  rootProjectId,
  rootWorkspace,
} from "./setup/code-root-host-http";

let client: CodeHttpChannelClient | undefined;
let release: (() => void) | undefined;
afterEach(() => {
  cleanup();
  release?.();
  client?.dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
  restoreCodeRootBrowser();
});

interface CreatedProject {
  id: string;
  name: string;
  path: string;
}

function stubProjectHttp(
  created: CreatedProject[],
  posts: Array<Record<string, unknown>>,
) {
  const fallback = createCodeRootHostFetch([], { rejectOpen: false });
  return async (url: string, options?: RequestInit) => {
    if (url.endsWith("/api/projects") && options?.method === "POST") {
      const body = JSON.parse(String(options.body)) as { name: string };
      posts.push(body);
      const project = {
        id: `30000000-0000-4000-8000-00000000000${created.length + 4}`,
        name: body.name,
        path: `/code/${body.name}`,
      };
      created.push(project);
      return Response.json({ project: { id: project.id } });
    }
    if (url.endsWith("/api/code-ui/workspaces"))
      return Response.json({
        workspaces: [
          rootWorkspace,
          ...created.map((project) => ({
            projectId: project.id,
            path: project.path,
            name: project.name,
            additionalDirectories: [],
          })),
        ],
      });
    if (url.endsWith("/rpc")) {
      const call = JSON.parse(String(options?.body)) as {
        service: string;
        method: string;
        args: Array<Record<string, unknown>>;
      };
      if (call.service === "workspace" && call.method === "open") {
        const path = String(call.args[0]?.path ?? "");
        const project = created.find((item) => item.path === path);
        if (project)
          return Response.json({
            result: {
              projectId: project.id,
              path: project.path,
              name: project.name,
              additionalDirectories: [],
            },
          });
      }
    }
    return fallback(url, options);
  };
}

async function mountWorkbench() {
  client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  client.registerWorkspaces([rootWorkspace]);
  release = bindCodeWorkspaceServices(client);
  const host = client;
  const platform = createCodePlatform(host);
  render(
    <ServiceProvider services={host.services}>
      <PlatformProvider platform={platform}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <SharedProjectNavigationProvider client={host}>
            <TabStoreProvider>
              <TooltipProvider>
                <Root
                  services={host.services}
                  platform={platform}
                  initialWorkspaceAbsPath="/code"
                  initialWorkspaceIdentity={JSON.stringify([
                    rootProjectId,
                    "/code",
                  ])}
                  restoreSession={false}
                  allowRemoteWorkspace={false}
                />
              </TooltipProvider>
            </TabStoreProvider>
          </SharedProjectNavigationProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
}

/** 添加项目是一次真实创建：POST 建项目 → 刷新列表 → 打开对应工作区标签。 */
it("侧栏添加项目打开表单，提交后创建并进入项目", async () => {
  installCodeRootBrowser();
  const created: CreatedProject[] = [];
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", stubProjectHttp(created, posts));
  await mountWorkbench();

  fireEvent.click(await screen.findByTestId(TID_PROJECT_ADD));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("新建项目");
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "验收项目" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));

  await waitFor(() =>
    expect(posts).toEqual([{ name: "验收项目", kind: "code" }]),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect((await screen.findAllByText("验收项目")).length).toBeGreaterThan(0);
});

it("空名称不能提交，取消不创建项目", async () => {
  installCodeRootBrowser();
  const created: CreatedProject[] = [];
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", stubProjectHttp(created, posts));
  await mountWorkbench();

  fireEvent.click(await screen.findByTestId(TID_PROJECT_ADD));
  await screen.findByRole("dialog");
  expect(
    screen.getByRole("button", { name: "创建" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "   " },
  });
  expect(
    screen.getByRole("button", { name: "创建" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(posts).toEqual([]);
});
