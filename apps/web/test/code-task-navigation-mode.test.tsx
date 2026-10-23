import type { ZCodeTaskMeta } from "@kenfutwork/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { Root } from "@zui/Root";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore";
import { afterEach, expect, it, vi } from "vitest";
import { requestCanvasDocumentOpen } from "../src/components/workbench/zcode/host/conversationWorkContext";
import {
  type DocumentPaneRendererProps,
  DocumentPaneRendererProvider,
} from "../src/components/workbench/zcode/host/DocumentPane";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import {
  admitProjectMode,
  SharedProjectNavigationProvider,
} from "../src/components/workbench/zcode/host/SharedProjectNavigation";
import { createHostWorkbenchNavigation } from "../src/components/workbench/zcode/host/workbenchNavigation";
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

const taskA = "a7100000-0000-4000-8000-000000000001";
const taskB = "a7200000-0000-4000-8000-000000000002";
const identity = JSON.stringify([rootProjectId, "/code"]);
const releases: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const release of releases.splice(0)) release();
  useZCodeSessionStore.setState({ workspaces: {} });
  vi.unstubAllGlobals();
  localStorage.clear();
  restoreCodeRootBrowser();
});
function documentRenderer({ tab, isVisible }: DocumentPaneRendererProps) {
  return <iframe title={tab.title} data-document-visible={String(isVisible)} />;
}
function meta(taskId: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: taskId,
    mode: "build",
    title: taskId === taskA ? "会话 A" : "会话 B",
    workspacePath: "/code",
    workspaceIdentity: identity,
    createdAt: taskId === taskA ? 2 : 1,
    updatedAt: taskId === taskA ? 2 : 1,
  };
}
async function openRoot(mode: "design" | "flow") {
  installCodeRootBrowser();
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const fallback = createCodeRootHostFetch(calls, { rejectOpen: false });
  const sharedWorkspace = {
    ...rootWorkspace,
    kind: "code" as const,
    enabledModes: ["code", "design"] as Array<"code" | "design">,
  };
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (url.endsWith("/workspaces"))
      return Response.json({ workspaces: [sharedWorkspace] });
    if (!url.endsWith("/events") && options?.body) {
      const call = JSON.parse(String(options.body));
      if (call.service === "workspace" && call.method === "open") {
        calls.push(call);
        return Response.json({ result: sharedWorkspace });
      }
      if (
        call.service === "file" &&
        call.method === "ensureConversationWorkspace"
      ) {
        calls.push(call);
        return Response.json({
          result: {
            ...sharedWorkspace,
            created: true,
            workspacePurpose: "conversation",
          },
        });
      }
      if (call.service === "zcode-task" && call.method === "getTaskMeta") {
        calls.push(call);
        return Response.json({ result: meta(call.args[0].taskId) });
      }
    }
    return fallback(url, options);
  });
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  client.registerWorkspaces([sharedWorkspace]);
  client.workspaces.registerTask(meta(taskA));
  client.workspaces.registerTask(meta(taskB));
  const navigation = createHostWorkbenchNavigation(
    window,
    ["code", "design", "flow"],
    (preset) =>
      preset === "flow" ? Promise.resolve(true) : admitProjectMode(preset),
  );
  client.setWorkPresetResolver(() =>
    navigation.getSnapshot().mode === "design" ? "design" : "code",
  );
  releases.push(
    bindCodeWorkspaceServices(client),
    () => client.dispose(),
    navigation.dispose,
  );
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <SharedProjectNavigationProvider client={client} navigation={navigation}>
        <DocumentPaneRendererProvider
          renderers={[{ resourceType: "canvas", component: documentRenderer }]}
        >
          <Root
            services={client.services}
            platform={createCodePlatform(client, {
              workbenchNavigation: navigation,
            })}
            initialWorkspaceAbsPath="/code"
            initialWorkspaceIdentity={identity}
            initialTaskId={taskA}
            workbenchGroupClientMode="web-remote-replayable"
            restoreSession={false}
            allowRemoteWorkspace={false}
            preferDirectoryBrowser
          />
        </DocumentPaneRendererProvider>
      </SharedProjectNavigationProvider>
    </ZCodeIntlProvider>,
  );
  await screen.findByRole("radio", { name: "Code" });
  // 设计面首帧依赖宿主的异步数据面；同步 act 只 flush 本次导航更新，不等待挂载中的 Suspense。
  act(() => {
    navigation.open("design");
  });
  act(() => {
    requestCanvasDocumentOpen({
      projectId: rootProjectId,
      documentId: "c7100000-0000-4000-8000-000000000001",
      title: "保持的画布",
    });
  });
  const canvas = await waitFor(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[title="保持的画布"]',
    );
    if (!frame) throw new Error("项目文档尚未挂载");
    return frame;
  });
  if (mode === "flow")
    act(() => {
      navigation.open("flow");
    });
  await waitFor(() =>
    expect(
      screen
        .getByRole("radio", { name: mode === "design" ? "Design" : "Flow" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  return { navigation, canvas, calls };
}

it.each(["design", "flow"] as const)(
  "真实Root的会话快捷导航保留%s方式、固定Task身份与常驻文档",
  async (mode) => {
    const f = await openRoot(mode);
    // 原快捷键读取真实Root的会话缓存并调用同一个handleSelectTask，覆盖ACK提升/恢复消费的Task主区接线。
    act(() => {
      useZCodeSessionStore
        .getState()
        .setTaskListCache("/code", [meta(taskA), meta(taskB)], identity);
      fireEvent.keyDown(window, {
        key: "]",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
      });
    });
    await waitFor(() =>
      expect(
        useZCodeSessionStore.getState().getWorkspaceState("/code", identity)
          .activeTaskId,
      ).toBe(taskB),
    );
    // 真实共享Provider已完成准入，不能让一个未绑定的pending Promise掩盖随后反向切Code。
    await act(async () => {
      expect(await admitProjectMode("code")).toBe(true);
    });
    expect(f.navigation.getSnapshot().mode).toBe(mode);
    expect(
      screen
        .getByRole("radio", { name: mode === "design" ? "Design" : "Flow" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.querySelector('iframe[title="保持的画布"]')).toBe(f.canvas);
    if (mode === "design")
      expect(f.canvas.getAttribute("data-document-visible")).toBe("true");
    else
      expect(
        document
          .querySelector('[data-workspace-embedded-surface="flow"]')
          ?.hasAttribute("hidden"),
      ).toBe(false);
  },
);

it("原侧栏新建任务的showChatMainView保留Design画布，只有显式Code按钮改变工作方式", async () => {
  const f = await openRoot("design");
  const buttons = await screen.findAllByRole("button", { name: "新建任务" });
  const button = buttons[0];
  if (!button) throw new Error("原侧栏新建任务入口缺失");
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() =>
    expect(
      useZCodeSessionStore.getState().getWorkspaceState("/code", identity)
        .activeTaskId,
    ).toBeNull(),
  );
  await act(async () => {
    expect(await admitProjectMode("code")).toBe(true);
  });
  expect(f.navigation.getSnapshot().mode).toBe("design");
  expect(document.querySelector('iframe[title="保持的画布"]')).toBe(f.canvas);
  expect(f.canvas.getAttribute("data-document-visible")).toBe("true");
  await act(async () => {
    fireEvent.click(screen.getByRole("radio", { name: "Code" }));
  });
  await waitFor(() => expect(f.navigation.getSnapshot().mode).toBe("code"));
  expect(document.querySelector('iframe[title="保持的画布"]')).toBe(f.canvas);
});
