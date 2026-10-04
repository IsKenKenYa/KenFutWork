import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { Root } from "@zui/index";
import { useAlertDialogStore } from "@zui/store/alertDialogStore";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { createCodeWorkspaceContextResolver } from "../src/components/workbench/zcode/host/workspaceServiceController";
import { bindCodeWorkspaceServices } from "../src/components/workbench/zcode/host/workspaceServices";
import {
  installCodeRootBrowser as installBrowserLayout,
  restoreCodeRootBrowser,
} from "./setup/code-root-host-browser";
import {
  createCodeRootHostFetch,
  rootProjectId,
  rootWorkspace,
} from "./setup/code-root-host-http";

const clients: CodeHttpChannelClient[] = [];
const releases: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const release of releases.splice(0)) release();
  for (const client of clients.splice(0)) client.dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
  restoreCodeRootBrowser();
});

it.each([true, false])(
  "无ZCode云服务的原Root显示工作台、目录选择及全局应答（指定目录：%s）",
  async (hasInitialDirectory) => {
    const calls: Array<{ service: string; method: string; args: unknown[] }> =
      [];
    const selection = { rejectOpen: true };
    installBrowserLayout();
    vi.stubGlobal("fetch", createCodeRootHostFetch(calls, selection));
    const client = new CodeHttpChannelClient({
      apiBase: "https://host.example",
    });
    clients.push(client);
    await client.connect();
    client.registerWorkspaces([rootWorkspace]);
    releases.push(bindCodeWorkspaceServices(client));
    const platform = createCodePlatform(client);
    const context = vi.fn((target) => installViewerContext(client, target));
    render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <Root
          services={client.services}
          platform={platform}
          {...(hasInitialDirectory
            ? {
                initialWorkspaceAbsPath: "/code",
                initialWorkspaceIdentity: JSON.stringify([
                  rootProjectId,
                  "/code",
                ]),
              }
            : {})}
          directoryServices={client.directoryServices()}
          onWorkspaceContextChange={context}
          workbenchGroupClientMode="web-remote-replayable"
          restoreSession={false}
          allowRemoteWorkspace={false}
          preferDirectoryBrowser
          initialWorkspaceLoadingFallback={<span>原入口加载</span>}
        />
      </ZCodeIntlProvider>,
    );
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.service === "modelSelectionService" &&
            call.method === "getView",
        ),
      ).toBe(true),
    );
    expect(
      calls.filter((call) =>
        [
          "oauth",
          "credential",
          "coding-plan-subscription",
          "onboarding-record",
          "bots",
        ].includes(call.service),
      ),
    ).toEqual([]);
    expect(await screen.findByRole("textbox")).not.toBeNull();
    expect(context).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/code",
        workspaceIdentity: JSON.stringify([rootProjectId, "/code"]),
      }),
    );
    expect(
      calls.some(
        (call) =>
          call.service === "file" &&
          call.method === "ensureConversationWorkspace",
      ),
    ).toBe(!hasInitialDirectory);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(await screen.findByText("显示隐藏目录")).not.toBeNull();
    const select = await screen.findByRole("button", { name: "选择此目录" });
    await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
    fireEvent.click(select);
    expect(
      (await screen.findAllByText(/目录项目已归档/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("显示隐藏目录")).not.toBeNull();
    selection.rejectOpen = false;
    fireEvent.click(screen.getByRole("button", { name: "选择此目录" }));
    await waitFor(() => expect(screen.queryByText("显示隐藏目录")).toBeNull());
    expect(context).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspacePath: "/code",
        workspaceIdentity: JSON.stringify([rootProjectId, "/code"]),
      }),
    );
    expect(
      calls
        .filter(
          (call) => call.service === "workspace" && call.method === "open",
        )
        .map((call) => call.args),
    ).toEqual([[{ path: "/fixture" }], [{ path: "/fixture" }]]);
    const alert = useAlertDialogStore.getState().requestAlert({
      title: "原全局提示",
      description: "真实宿主操作提示",
      actionLabel: "确认提示",
    });
    await act(async () => {
      await Promise.resolve();
    });
    const confirm = await screen.findByRole("button", { name: /确认提示/ });
    fireEvent.click(confirm);
    await expect(alert).resolves.toBe(true);
  },
);

function installViewerContext(
  client: CodeHttpChannelClient,
  target: { workspacePath: string | null; workspaceIdentity?: string | null },
) {
  createCodeWorkspaceContextResolver(client)({
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity ?? null,
  });
}

it("原Root新建任务动作读取Project新默认B，已选旧Task及其文件上下文仍固定A", async () => {
  installBrowserLayout();
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const fixtureFetch = createCodeRootHostFetch(calls, { rejectOpen: false });
  const oldTaskId = "50000000-0000-4000-8000-000000000005";
  const neighborProjectId = "60000000-0000-4000-8000-000000000006";
  const neighborIdentity = JSON.stringify([neighborProjectId, "/B"]);
  const neighborWorkspace = {
    ...rootWorkspace,
    projectId: neighborProjectId,
    path: "/B",
  };
  let defaultPath = "/A";
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) =>
    url.endsWith("/workspaces")
      ? Response.json({
          workspaces: [
            { ...rootWorkspace, path: defaultPath },
            neighborWorkspace,
          ],
        })
      : fixtureFetch(url, options),
  );
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  clients.push(client);
  await client.connect();
  client.registerWorkspaces([
    { ...rootWorkspace, path: "/A" },
    neighborWorkspace,
  ]);
  client.workspaces.registerTask({
    taskId: oldTaskId,
    projectId: rootProjectId,
    workspacePath: "/A",
  });
  useZCodeSessionStore
    .getState()
    .setActiveTaskId("/B", "neighbor-task", neighborIdentity);
  releases.push(bindCodeWorkspaceServices(client));
  const identityA = JSON.stringify([rootProjectId, "/A"]);
  const identityB = JSON.stringify([rootProjectId, "/B"]);
  const context = vi.fn((target) => installViewerContext(client, target));
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <Root
        services={client.services}
        platform={createCodePlatform(client)}
        initialWorkspaceAbsPath="/A"
        initialWorkspaceIdentity={identityA}
        initialTaskId={oldTaskId}
        onWorkspaceContextChange={context}
        directoryServices={client.directoryServices()}
        workbenchGroupClientMode="web-remote-replayable"
        restoreSession={false}
        allowRemoteWorkspace={false}
      />
    </ZCodeIntlProvider>,
  );
  await waitFor(() =>
    expect(context).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/A",
        workspaceIdentity: identityA,
      }),
    ),
  );
  defaultPath = "/B";
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  await waitFor(() =>
    expect(context).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/B",
        workspaceIdentity: identityB,
      }),
    ),
  );
  expect(
    useZCodeSessionStore.getState().getWorkspaceState("/A", identityA)
      .activeTaskId,
  ).toBe(oldTaskId);
  expect(
    useZCodeSessionStore.getState().getWorkspaceState("/B", identityB)
      .activeTaskId,
  ).toBeNull();
  expect(
    useZCodeSessionStore.getState().getWorkspaceState("/B", neighborIdentity)
      .activeTaskId,
  ).toBe("neighbor-task");
  await client.services.zcodeTaskService.getTaskMeta({
    taskId: oldTaskId,
    workspacePath: "/B",
    workspaceIdentity: identityB,
  });
  expect(
    calls.filter((call) => call.method === "getTaskMeta").at(-1)?.args,
  ).toEqual([
    {
      taskId: oldTaskId,
      workspacePath: "/A",
      workspaceIdentity: identityA,
      projectId: rootProjectId,
    },
  ]);
});

it("两个原Root在同根使用各自qualified Project桶，读取失败不会转借另一个Project", async () => {
  installBrowserLayout();
  const firstCalls: Array<{
    service: string;
    method: string;
    args: unknown[];
  }> = [];
  const secondCalls: Array<{
    service: string;
    method: string;
    args: unknown[];
  }> = [];
  const firstFetch = createCodeRootHostFetch(firstCalls, { rejectOpen: false });
  const secondFetch = createCodeRootHostFetch(secondCalls, {
    rejectOpen: false,
  });
  vi.stubGlobal("fetch", (url: string, options?: RequestInit) =>
    url.startsWith("https://first.example")
      ? firstFetch(url, options)
      : secondFetch(url, options),
  );
  const secondProject = "40000000-0000-4000-8000-000000000004";
  const firstIdentity = JSON.stringify([rootProjectId, "/shared"]);
  const secondIdentity = JSON.stringify([secondProject, "/shared"]);
  const contexts = [vi.fn(), vi.fn()];
  for (const [index, projectId] of [rootProjectId, secondProject].entries()) {
    const client = new CodeHttpChannelClient({
      apiBase: index === 0 ? "https://first.example" : "https://second.example",
    });
    clients.push(client);
    await client.connect();
    client.registerWorkspaces([
      { ...rootWorkspace, projectId, path: "/shared" },
    ]);
    releases.push(bindCodeWorkspaceServices(client));
    const identity = index === 0 ? firstIdentity : secondIdentity;
    render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <Root
          services={client.services}
          platform={createCodePlatform(client)}
          initialWorkspaceAbsPath="/shared"
          initialWorkspaceIdentity={identity}
          onWorkspaceContextChange={(target) => {
            contexts[index]!(target);
            installViewerContext(client, target);
          }}
          directoryServices={client.directoryServices()}
          workbenchGroupClientMode="web-remote-replayable"
          restoreSession={false}
          allowRemoteWorkspace={false}
        />
      </ZCodeIntlProvider>,
    );
    await waitFor(() =>
      expect(contexts[index]).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceIdentity: identity }),
      ),
    );
    await expect(
      client.services.fileService.readTextFile({ path: "/shared/file.txt" }),
    ).rejects.toThrow("该能力未接通");
    await expect(
      client.services.fileService.readTextFile({ path: "/shared/file.txt" }),
    ).rejects.toThrow("该能力未接通");
  }
  const reads = (calls: typeof firstCalls) =>
    calls
      .filter((call) => call.method === "readTextFile")
      .map((call) => call.args);
  expect(reads(firstCalls)).toEqual(
    Array.from({ length: 2 }, () => [
      {
        path: "/shared/file.txt",
        viewerScope: { kind: "project", projectId: rootProjectId },
      },
    ]),
  );
  expect(reads(secondCalls)).toEqual(
    Array.from({ length: 2 }, () => [
      {
        path: "/shared/file.txt",
        viewerScope: { kind: "project", projectId: secondProject },
      },
    ]),
  );
  expect(
    useZCodeSessionStore.getState().getWorkspaceState("/shared", firstIdentity),
  ).not.toBe(
    useZCodeSessionStore
      .getState()
      .getWorkspaceState("/shared", secondIdentity),
  );
});
