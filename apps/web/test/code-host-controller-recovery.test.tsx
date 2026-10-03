import { renderHook, waitFor } from "@testing-library/react";
import { useGlobalTaskList } from "@zui/hooks/useGlobalTaskList";
import { ServiceProvider } from "@zui/hooks/useServices";
import { useWorkspaceTaskLists } from "@zui/hooks/useWorkspaceTaskLists";
import { type ReactNode, useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { bindCodeWorkspaceServices } from "../src/components/workbench/zcode/host/workspaceServices";

import { createControllerHttpFixture } from "./setup/code-host-controller-http";

afterEach(() => vi.unstubAllGlobals());

function ControllerServiceProvider({
  client,
  children,
}: {
  client: CodeHttpChannelClient;
  children: ReactNode;
}) {
  const services = useSyncExternalStore(
    client.subscribeServices,
    () => client.services,
  );
  return <ServiceProvider services={services}>{children}</ServiceProvider>;
}

it("通知断线后原全局目录恢复新租约并自动显示期间新增的任务，不重建会话服务", async () => {
  const fixture = createControllerHttpFixture();
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  const initialAgent = client.services.zcodeAgentService;
  const view = renderHook(
    () =>
      useGlobalTaskList({
        kind: "active",
        workspaceTabs: [
          {
            id: "workspace",
            workspacePath: "/项目",
            kind: "workspace",
            label: "项目",
          },
        ],
        sortBy: "updated",
        searchQuery: "",
        expanded: true,
        collapsedLimit: 10,
      }),
    {
      wrapper: ({ children }) => (
        <ControllerServiceProvider client={client}>
          {children}
        </ControllerServiceProvider>
      ),
    },
  );
  try {
    await waitFor(() =>
      expect(view.result.current.items.map((item) => item.title)).toEqual([
        "连接前任务",
      ]),
    );
    fixture.disconnect(0);
    await waitFor(() =>
      expect(view.result.current.items.map((item) => item.title)).toEqual([
        "连接前任务",
        "断线期间新任务",
      ]),
    );
    expect(fixture.leases).toContain("connection-2-controller/tasks-index");
    expect(fixture.leases).toContain("connection-2-controller/workspaces");
    fixture.disconnect(1);
    await waitFor(() =>
      expect(view.result.current.items.map((item) => item.title)).toEqual([
        "连接前任务",
        "断线期间新任务",
        "第二次断线新任务",
      ]),
    );
    expect(fixture.leases).toContain("connection-3-controller/tasks-index");
    expect(client.services.zcodeAgentService).toBe(initialAgent);
  } finally {
    view.unmount();
    client.dispose();
  }
});

it.each([
  ["initializeConversationV4", 401],
  ["initializeConversationV4", 403],
  ["getView", 401],
  ["getView", 403],
])(
  "恢复 %s 返回 %s 时立即拒绝等待调用，不发布新目录租约或继续重连",
  async (member, status) => {
    vi.useFakeTimers();
    let close: () => void = () => {
      throw new Error("测试通知连接尚未建立");
    };
    let connection = 0;
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/events")) {
        connection += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              close = () => controller.close();
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    event: "ready",
                    reconnectDelayMs: 100,
                    hello: { connectionId: `connection-${connection}` },
                  })}\n\n`,
                ),
              );
            },
          }),
        );
      }
      const request = JSON.parse(String(options?.body));
      return connection > 1 && request.method === member
        ? Response.json({ error: { message: "认证已失效" } }, { status })
        : Response.json({ result: null });
    });
    vi.stubGlobal("fetch", fetcher);
    const client = new CodeHttpChannelClient({
      apiBase: "https://host.example",
    });
    const published = vi.fn();
    client.subscribeServices(published);
    try {
      await client.connect();
      await client.services.zcodeAgentService.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "auth-test",
        appVersion: "integration",
        clientKind: "web",
      });
      close();
      await vi.advanceTimersByTimeAsync(0);
      const rejected = vi.fn();
      void client.services.providerSettingsService.getView().catch(rejected);
      await vi.advanceTimersByTimeAsync(100);
      expect(rejected).toHaveBeenCalledWith(
        expect.objectContaining({ message: "认证已失效" }),
      );
      expect(published).not.toHaveBeenCalled();
      const requests = fetcher.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetcher.mock.calls).toHaveLength(requests);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  },
);

it("断线丢失 task_created 后原项目目录重读成员行，空 sessions-index 不能吞掉新增任务", async () => {
  const fixture = createControllerHttpFixture();
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  const release = bindCodeWorkspaceServices(client);
  const view = renderHook(
    () =>
      useWorkspaceTaskLists({
        workspaceTabs: [
          {
            id: "workspace",
            kind: "workspace",
            workspacePath: "/项目",
            label: "项目",
          },
        ],
        activeWorkspacePath: "/项目",
        sortBy: "updated",
        visibleLimitByWorkspaceKey: {},
        defaultVisibleLimit: 10,
      }),
    {
      wrapper: ({ children }) => (
        <ControllerServiceProvider client={client}>
          {children}
        </ControllerServiceProvider>
      ),
    },
  );
  try {
    await waitFor(() =>
      expect(
        view.result.current.groups.flatMap((group) =>
          group.items.map((item) => item.title),
        ),
      ).toEqual(["连接前任务"]),
    );
    fixture.disconnect(0);
    await waitFor(() =>
      expect(
        view.result.current.groups.flatMap((group) =>
          group.items.map((item) => item.title),
        ),
      ).toEqual(expect.arrayContaining(["连接前任务", "断线期间新任务"])),
    );
  } finally {
    view.unmount();
    release();
    client.dispose();
  }
});
