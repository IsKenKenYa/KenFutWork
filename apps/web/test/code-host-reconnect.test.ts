import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import {
  controllerProjectId,
  controllerTaskRoot,
  controllerWorkspaceIdentity,
  createControllerHttpFixture,
} from "./setup/code-host-controller-http";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("重复恢复只刷新原服务与租约，命令不重放，qualified refs与动态ID各自隔离", async () => {
  vi.useFakeTimers();
  const fixture = createControllerHttpFixture();
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  const secondProject = "20000000-0000-4000-8000-000000000002";
  const secondIdentity = JSON.stringify([secondProject, controllerTaskRoot]);
  client.registerWorkspaces([
    {
      projectId: controllerProjectId,
      path: controllerTaskRoot,
      name: "一",
      additionalDirectories: [],
    },
    {
      projectId: secondProject,
      path: controllerTaskRoot,
      name: "二",
      additionalDirectories: [],
    },
  ]);
  const scopeA = {
    workspacePath: controllerTaskRoot,
    workspaceIdentity: controllerWorkspaceIdentity,
  };
  const scopeB = {
    workspacePath: controllerTaskRoot,
    workspaceIdentity: secondIdentity,
  };
  const agent = client.getChannel("zcodeAgentService");
  const initialServices = client.services;
  const a = vi.fn();
  const b = vi.fn();
  const lifecycle = vi.fn();
  const modelChanges = vi.fn();
  const a1 = agent.listen("onDynamicSessionsIndexFrame", scopeA)(a);
  const a2 = agent.listen("onDynamicSessionsIndexFrame", scopeA)(() => {});
  const b1 = agent.listen("onDynamicSessionsIndexFrame", scopeB)(b);
  const onAgentRuntimeLifecycle =
    client.services.zcodeAgentService.onAgentRuntimeLifecycle;
  if (!onAgentRuntimeLifecycle)
    throw new Error("Code 宿主未提供运行时生命周期订阅。");
  const lifecycleSubscription = onAgentRuntimeLifecycle(lifecycle);
  const modelSubscription =
    client.services.modelSelectionService.onDidChange(modelChanges);
  const terminalA = vi.fn();
  const terminalB = vi.fn();
  const watcherA = vi.fn();
  const watcherB = vi.fn();
  const dynamic = [
    client.services.terminalService.onDynamicData("terminal-a")(terminalA),
    client.services.terminalService.onDynamicData("terminal-b")(terminalB),
    client.services.fileWatcherService.onDynamicChange("watcher-a")(watcherA),
    client.services.fileWatcherService.onDynamicChange("watcher-b")(watcherB),
  ];
  try {
    await client.connect();
    await client.services.zcodeAgentService.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "reconnect-test",
      appVersion: "integration",
      clientKind: "web",
    });
    await agent.call("sendConversationCommandV4", [
      {
        ...scopeA,
        envelope: {
          type: "createSession",
          payload: { workspaceId: controllerTaskRoot },
        },
      },
    ]);
    fixture.disconnect(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.services.zcodeAgentService).toBe(
      initialServices.zcodeAgentService,
    );
    expect(client.services.windowControllerService).not.toBe(
      initialServices.windowControllerService,
    );
    fixture.emit(1, {
      event: "onDynamicSessionsIndexFrame",
      ...scopeA,
      frame: "A",
    });
    fixture.emit(1, {
      event: "onDynamicSessionsIndexFrame",
      ...scopeB,
      frame: "B",
    });
    fixture.emit(1, {
      event: "service",
      service: "terminal",
      name: "onDynamicData",
      terminalId: "terminal-b",
      data: "output",
    });
    fixture.emit(1, {
      event: "service",
      service: "file-watcher",
      name: "onDynamicChange",
      watcherId: "watcher-a",
      data: { dirPath: controllerTaskRoot },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(a).toHaveBeenCalledExactlyOnceWith("A");
    expect(b).toHaveBeenCalledExactlyOnceWith("B");
    expect(terminalA).not.toHaveBeenCalled();
    expect(terminalB).toHaveBeenCalledExactlyOnceWith("output");
    expect(watcherA).toHaveBeenCalledExactlyOnceWith({
      dirPath: controllerTaskRoot,
    });
    expect(watcherB).not.toHaveBeenCalled();
    a1.dispose();
    a1.dispose();
    fixture.disconnect(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(
      lifecycle.mock.calls.filter(
        ([event]) =>
          event.workspaceKey === controllerWorkspaceIdentity &&
          event.state === "available",
      ),
    ).toHaveLength(2);
    a2.dispose();
    fixture.disconnect(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(
      lifecycle.mock.calls.filter(
        ([event]) =>
          event.workspaceKey === controllerWorkspaceIdentity &&
          event.state === "available",
      ),
    ).toHaveLength(2);
    expect(
      lifecycle.mock.calls.filter(
        ([event]) =>
          event.workspaceKey === secondIdentity && event.state === "available",
      ),
    ).toHaveLength(3);
    expect(modelChanges).toHaveBeenCalledTimes(3);
    expect(
      fixture.requests.filter(
        (request) => request.method === "sendConversationCommandV4",
      ),
    ).toEqual([
      expect.objectContaining({
        connectionId: "connection-1",
        args: [
          expect.objectContaining({
            ...scopeA,
            projectId: controllerProjectId,
            envelope: {
              type: "createSession",
              payload: { workspaceId: controllerProjectId },
            },
          }),
        ],
      }),
    ]);
    expect(
      fixture.requests
        .filter((request) => request.method === "initializeConversationV4")
        .map((request) => request.connectionId),
    ).toEqual(["connection-1", "connection-2", "connection-3", "connection-4"]);
  } finally {
    a1.dispose();
    a2.dispose();
    b1.dispose();
    lifecycleSubscription.dispose();
    modelSubscription.dispose();
    for (const subscription of dynamic) subscription.dispose();
    client.dispose();
  }
});

it("SSE读取跨chunk的CRLF和多行data；关闭会取消reader并拒绝挂起调用", async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let body!: ReadableStream<Uint8Array>;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options: RequestInit) => {
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      });
      options.signal?.addEventListener(
        "abort",
        () => stream.error(new DOMException("已关闭", "AbortError")),
        { once: true },
      );
      return new Response(body);
    }),
  );
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  const ready = client.connect();
  await Promise.resolve();
  const encoder = new TextEncoder();
  stream.enqueue(
    encoder.encode(': keepalive\r\n\r\ndata: {"event":"ready",\r\n'),
  );
  stream.enqueue(
    encoder.encode('data: "hello":{"connectionId":"crlf"}}\r\n\r'),
  );
  stream.enqueue(encoder.encode("\n"));
  await ready;
  stream.close();
  await vi.advanceTimersByTimeAsync(0);
  const waiting = client.connect();
  client.dispose();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  await expect(client.connect()).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(body.locked).toBe(false);
});
