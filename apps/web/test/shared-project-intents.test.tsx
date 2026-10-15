import type { CodeUiWorkspace } from "@kenfutwork/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WorkspaceMainView } from "@zui/app-shell/types.js";
import {
  TabStoreProvider,
  useTabStore,
  useTabStoreApi,
} from "@zui/store/TabStoreProvider.js";
import type { TabStore } from "@zui/store/tabStore.js";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostWorkbenchNavigation } from "../../../packages/zcode-shared/dist/index.js";
import {
  OPEN_DOCUMENT_EVENT,
  takeCanvasDocumentOpen,
} from "../src/components/workbench/zcode/host/conversationWorkContext";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import {
  admitProjectMode,
  SharedProjectNavigation,
  SharedProjectNavigationProvider,
  useSharedProjectTabs,
} from "../src/components/workbench/zcode/host/SharedProjectNavigation";
import { setSurfaceApiBase } from "../src/components/workbench/zcode/host/surfaceApi";
import { useWorkbenchSurfaceMode } from "../src/components/workbench/zcode/host/useWorkbenchSurfaceMode";
import { createHostWorkbenchNavigation } from "../src/components/workbench/zcode/host/workbenchNavigation";

const harness = vi.hoisted(() => ({
  navigation: null as HostWorkbenchNavigation | null,
  json: vi.fn(),
}));
vi.mock("@zui/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () =>
    harness.navigation ? { workbenchNavigation: harness.navigation } : null,
}));

const code: CodeUiWorkspace = {
  projectId: "a1000000-0000-4000-8000-000000000001",
  path: "/code",
  name: "Code 项目",
  kind: "code",
  enabledModes: ["code"],
  additionalDirectories: [],
};
const design: CodeUiWorkspace = {
  ...code,
  projectId: "a2000000-0000-4000-8000-000000000002",
  path: "/design",
  name: "Design 项目",
  kind: "design",
  enabledModes: ["design"],
};
const sharedA: CodeUiWorkspace = {
  ...code,
  projectId: "a3000000-0000-4000-8000-000000000003",
  path: "/same",
  name: "项目 A",
  enabledModes: ["code", "design"],
};
const sharedB: CodeUiWorkspace = {
  ...sharedA,
  projectId: "a4000000-0000-4000-8000-000000000004",
  name: "项目 B",
};
const canvasA = "c1000000-0000-4000-8000-000000000001";
const canvasB = "c2000000-0000-4000-8000-000000000002";
const disposals: Array<() => void> = [];
beforeEach(() => {
  vi.resetAllMocks();
  setSurfaceApiBase("http://navigation.test");
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  for (const project of [code, design, sharedA, sharedB])
    takeCanvasDocumentOpen(project.projectId);
  harness.navigation = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setSurfaceApiBase("");
  localStorage.clear();
});
function Probe({
  initialProject,
  ready,
}: {
  initialProject: CodeUiWorkspace;
  ready: (store: TabStore) => void;
}) {
  const store = useTabStoreApi();
  useSharedProjectTabs([]);
  const identity = useTabStore((state) => state.activeWorkspaceIdentity);
  const [view, setView] = useState<WorkspaceMainView>("chat");
  useWorkbenchSurfaceMode({
    workspaceMainView: view,
    setWorkspaceMainView: setView,
  });
  useLayoutEffect(() => {
    store.getState().addTab(initialProject.path, {
      workspaceIdentity: JSON.stringify([
        initialProject.projectId,
        initialProject.path,
      ]),
    });
    ready(store);
  }, [initialProject, ready, store]);
  return (
    <>
      <SharedProjectNavigation />
      <output data-testid="active-project">{identity}</output>
      <output data-testid="main-view">{view}</output>
      <button type="button" onClick={() => setView("automations")}>
        自动化
      </button>
    </>
  );
}
function sendNavigation(data: {
  mode?: "code" | "design" | "flow";
  canvasId?: string;
}) {
  fireEvent(
    window,
    new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: {
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design"],
        ...(data.mode ? { mode: data.mode } : {}),
        ...(data.canvasId
          ? {
              documentTarget: {
                resourceType: "canvas",
                documentId: data.canvasId,
              },
            }
          : {}),
      },
    }),
  );
}
async function fixture(
  initialProject: CodeUiWorkspace = code,
  options: {
    beforeRender?: (
      navigation: ReturnType<typeof createHostWorkbenchNavigation>,
    ) => void;
  } = {},
) {
  const client = new CodeHttpChannelClient({
    apiBase: "http://navigation.test",
  });
  client.registerWorkspaces([code, design, sharedA, sharedB]);
  vi.spyOn(client, "connect").mockResolvedValue();
  vi.spyOn(client, "refreshWorkspaces").mockImplementation(async () =>
    client.workspaces.projectCatalog(),
  );
  const rpc = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    const project = client.workspaces
      .projectCatalog()
      .find((item) => item.projectId === input.args[0].projectId);
    if (!project) throw new Error("测试项目不存在");
    return Response.json({ result: project });
  });
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/code-ui/rpc") return rpc(url, init);
    const result = await harness.json(path, init);
    return init?.method === "PATCH"
      ? new Response(null, { status: 204 })
      : Response.json(result);
  });
  harness.json.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const id = url.split("/").at(-1);
      const project = client.workspaces
        .projectCatalog()
        .find((item) => item.projectId === id);
      if (!project) throw new Error("测试项目不存在");
      client.registerWorkspaces([
        {
          ...project,
          enabledModes: JSON.parse(String(init.body)).enabled_modes,
        },
      ]);
      return {};
    }
    const id = url.split("/").at(-1);
    return {
      canvas: {
        id,
        projectId:
          id === canvasB ? sharedB.projectId : initialProject.projectId,
        name: id === canvasB ? "画布 B" : "画布 A",
      },
    };
  });
  const navigation = createHostWorkbenchNavigation(
    window,
    ["code", "design"],
    (mode) =>
      mode === "flow" ? Promise.resolve(true) : admitProjectMode(mode),
  );
  harness.navigation = navigation;
  options.beforeRender?.(navigation);
  let tabs: TabStore | undefined;
  const ready = (store: TabStore) => {
    tabs = store;
  };
  const tree = () => (
    <TabStoreProvider>
      <SharedProjectNavigationProvider client={client} navigation={navigation}>
        <Probe initialProject={initialProject} ready={ready} />
      </SharedProjectNavigationProvider>
    </TabStoreProvider>
  );
  const rendered = render(tree());
  disposals.push(() => {
    client.dispose();
    navigation.dispose();
  });
  await waitFor(() =>
    expect(screen.getByTestId("active-project").textContent).toBe(
      JSON.stringify([initialProject.projectId, initialProject.path]),
    ),
  );
  if (!tabs) throw new Error("真实 Tab store 未绑定");
  return {
    client,
    navigation,
    tabs,
    rpc,
    rerender: () => rendered.rerender(tree()),
  };
}
function canvasReads() {
  return harness.json.mock.calls.filter(([url]) =>
    String(url).startsWith("/api/canvases/"),
  );
}
function patches() {
  return harness.json.mock.calls.filter(([, init]) => init?.method === "PATCH");
}

it("画布深链读取失败后只显式重试；provider重渲染与能力推送不重放", async () => {
  const f = await fixture(sharedA);
  harness.json.mockRejectedValueOnce(new Error("画布读取暂时失败"));
  await act(async () => sendNavigation({ mode: "design", canvasId: canvasA }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "画布读取暂时失败",
  );
  expect(canvasReads()).toHaveLength(1);
  f.rerender();
  await act(async () => sendNavigation({}));
  expect(canvasReads()).toHaveLength(1);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "重试画布" })),
  );
  await waitFor(() => expect(f.navigation.getSnapshot().mode).toBe("design"));
  expect(canvasReads()).toHaveLength(2);
  expect(f.rpc).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "重试画布" })).toBeNull();
});
it("取消跨方式共享后深链可重新显式发起，取消期间不改项目也不自动重试", async () => {
  const f = await fixture(code);
  await act(async () => sendNavigation({ mode: "design", canvasId: canvasA }));
  await screen.findByRole("button", { name: "启用 Design" });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "取消" })),
  );
  await screen.findByRole("button", { name: "重试画布" });
  expect(f.navigation.getSnapshot().mode).toBe("code");
  expect(f.rpc).not.toHaveBeenCalled();
  expect(patches()).toHaveLength(0);
  await act(async () => sendNavigation({}));
  expect(canvasReads()).toHaveLength(1);
  await act(async () => sendNavigation({ mode: "design", canvasId: canvasA }));
  await act(async () =>
    fireEvent.click(await screen.findByRole("button", { name: "启用 Design" })),
  );
  await waitFor(() => expect(f.navigation.getSnapshot().mode).toBe("design"));
  expect(canvasReads()).toHaveLength(2);
  expect(patches()).toHaveLength(1);
  expect(f.tabs.getState().activeWorkspaceIdentity).toBe(
    JSON.stringify([code.projectId, code.path]),
  );
});
it("A画布读取迟到不得打开A或抢走B文档焦点", async () => {
  const f = await fixture(sharedA);
  let finishA!: (result: unknown) => void;
  harness.json.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishA = resolve;
      }),
  );
  const opened: string[] = [];
  const listen = (event: Event) =>
    opened.push(
      (event as CustomEvent<{ documentId: string }>).detail.documentId,
    );
  window.addEventListener(OPEN_DOCUMENT_EVENT, listen);
  try {
    await act(async () => sendNavigation({ canvasId: canvasA }));
    await act(async () => sendNavigation({ canvasId: canvasB }));
    await waitFor(() => expect(opened).toEqual([canvasB]));
    await act(async () =>
      finishA({
        canvas: { id: canvasA, projectId: sharedA.projectId, name: "画布 A" },
      }),
    );
    expect(opened).toEqual([canvasB]);
    expect(f.tabs.getState().activeWorkspaceIdentity).toBe(
      JSON.stringify([sharedB.projectId, sharedB.path]),
    );
    expect(f.rpc.mock.calls).toHaveLength(1);
  } finally {
    window.removeEventListener(OPEN_DOCUMENT_EVENT, listen);
  }
});
it("A的open RPC已在飞，B先成功后A只能登记catalog，不能切回同目录的A项目", async () => {
  const f = await fixture(sharedA);
  let finishA!: (response: Response) => void;
  f.rpc.mockImplementation(async (_url, init) => {
    const id = JSON.parse(String(init?.body)).args[0].projectId;
    return id === sharedA.projectId
      ? new Promise<Response>((resolve) => {
          finishA = resolve;
        })
      : Response.json({ result: sharedB });
  });
  await act(async () => sendNavigation({ canvasId: canvasA }));
  await waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(1));
  await act(async () => sendNavigation({ canvasId: canvasB }));
  await waitFor(() =>
    expect(f.tabs.getState().activeWorkspaceIdentity).toBe(
      JSON.stringify([sharedB.projectId, sharedB.path]),
    ),
  );
  await act(async () => finishA(Response.json({ result: sharedA })));
  expect(f.tabs.getState().activeWorkspaceIdentity).toBe(
    JSON.stringify([sharedB.projectId, sharedB.path]),
  );
  expect(f.client.projectForPath("/same")?.projectId).toBe(sharedB.projectId);
  expect(takeCanvasDocumentOpen(sharedB.projectId)?.documentId).toBe(canvasB);
  expect(takeCanvasDocumentOpen(sharedA.projectId)).toBeUndefined();
});
it("初始父Design模式等待真实项目恢复与用户确认，取消留Code且不创建执行身份", async () => {
  const f = await fixture(code, {
    beforeRender: () => sendNavigation({ mode: "design" }),
  });
  await screen.findByRole("button", { name: "启用 Design" });
  expect(f.navigation.getSnapshot().mode).toBe("code");
  expect(screen.getByTestId("main-view").textContent).toBe("chat");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "取消" })),
  );
  expect(f.navigation.getSnapshot().mode).toBe("code");
  expect(patches()).toHaveLength(0);
  expect(f.rpc).not.toHaveBeenCalled();
  await act(async () => sendNavigation({ mode: "design" }));
  await act(async () =>
    fireEvent.click(await screen.findByRole("button", { name: "启用 Design" })),
  );
  await waitFor(() =>
    expect(screen.getByTestId("main-view").textContent).toBe("design"),
  );
  expect(f.navigation.getSnapshot().mode).toBe("design");
  expect(f.tabs.getState().activeWorkspaceIdentity).toBe(
    JSON.stringify([code.projectId, code.path]),
  );
  expect(f.rpc).not.toHaveBeenCalled();
});
it("已选Design时恢复Code-only项目先回默认Code；取消不启用Design", async () => {
  const f = await fixture(code, {
    beforeRender: (navigation) => navigation.setActiveMode("design"),
  });
  await screen.findByRole("button", { name: "启用 Design" });
  await waitFor(() => expect(f.navigation.getSnapshot().mode).toBe("code"));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "取消" })),
  );
  expect(screen.getByTestId("main-view").textContent).toBe("chat");
  expect(patches()).toHaveLength(0);
  f.rerender();
  await act(async () => sendNavigation({}));
  expect(screen.queryByRole("button", { name: "启用 Design" })).toBeNull();
});
it("Design-only项目跳到Code内容先确认；取消保留Design，确认后正确显示请求的内容页", async () => {
  const f = await fixture(design, {
    beforeRender: (navigation) => navigation.setActiveMode("design"),
  });
  await waitFor(() =>
    expect(screen.getByTestId("main-view").textContent).toBe("design"),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "自动化" })),
  );
  await screen.findByRole("button", { name: "启用 Code" });
  expect(f.navigation.getSnapshot().mode).toBe("design");
  expect(screen.getByTestId("main-view").textContent).toBe("design");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "取消" })),
  );
  expect(f.navigation.getSnapshot().mode).toBe("design");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "自动化" })),
  );
  await act(async () =>
    fireEvent.click(await screen.findByRole("button", { name: "启用 Code" })),
  );
  await waitFor(() =>
    expect(screen.getByTestId("main-view").textContent).toBe("automations"),
  );
  expect(f.navigation.getSnapshot().mode).toBe("code");
  expect(f.rpc).not.toHaveBeenCalled();
});
