import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { createAgentConversationTransport } from "@zui/v4/agentConversationTransport";
import { SessionDataLayer } from "@zui/v4/sessionDataLayer";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("Code 宿主离线时调用等待新连接，关闭即取消等待与重连计时器", async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"event":"ready","hello":{"connectionId":"one"}}\n\n',
              ),
            );
          },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  try {
    await client.connect();
    stream.close();
    await vi.advanceTimersByTimeAsync(0);
    const received = vi.fn();
    const pending = client.services.providerSettingsService
      .getView()
      .then(received);
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(received).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.dispose();
    await expect(pending).rejects.toThrow("Code 宿主已关闭");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    client.dispose();
  }
});

it("Code 宿主认证失效立即拒绝等待调用，关闭页面后不继续重试", async () => {
  const fetcher = vi.fn(async () => new Response("未认证", { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  try {
    await expect(client.connect()).rejects.toThrow("401");
    await expect(
      client.services.providerSettingsService.getView(),
    ).rejects.toThrow("401");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    client.dispose();
  }
});

it("同一宿主断线后原 SessionDataLayer 恢复主子独立转录，释放子面板不会阻断主会话", async () => {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  const emit = (index: number, value: unknown) =>
    streams[index]!.enqueue(
      encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
    );
  const hello = (index: number) =>
    protocol.helloMessageSchema.parse({
      kind: "hello",
      protocolVersion: 3,
      connectionId: `owned-${index}`,
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      serverTime: 1,
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
      auth: {},
    });
  const snapshot = (sessionId: string, index: number) =>
    protocol.conversationSnapshotSchema.parse({
      protocolVersion: 1,
      sessionId,
      logEpoch: `${sessionId}-epoch`,
      seq: index,
      revision: index,
      control: {
        phase: "draft",
        sessionEnded: false,
        canStop: false,
        stopState: "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
        lastError: null,
        apiRetry: null,
      },
      availability: Object.fromEntries(
        [
          "fork",
          "compact",
          "switchModelConfig",
          "setFollowupMode",
          "queueEdit",
          "sendQueuedNow",
          "pauseGoal",
          "resumeGoal",
        ].map((key) => [
          key,
          { allowed: false, reasonCode: "guard.capabilityUnavailable" },
        ]),
      ),
      inputRouting: { mode: "startNow" },
      config: {
        provider: "zcode",
        model: "test",
        thought: "",
        followupMode: "queue",
        mode: "build",
      },
      usage: {
        contextWindow: null,
        cumulative: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      queue: { items: [], autoDrain: true },
      pendingInteractions: [],
      pendingCommands: [],
      backgroundWorks: [],
      goal: null,
      plan: null,
      rows: {
        totalCount: 1,
        firstRowId: 1,
        window: [
          {
            kind: "assistantText",
            rowId: 1,
            turnId: "turn",
            createdAt: 1,
            createdAtSeq: 1,
            text: `${sessionId} 正文 ${index}`,
            state: "complete",
          },
        ],
      },
    });
  const requests: Array<{
    method: string;
    connectionId: string;
    args: Array<{ sessionId?: string }>;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/events")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
            emit(streams.length - 1, {
              event: "ready",
              hello: hello(streams.length),
              reconnectDelayMs: 100,
            });
          },
        });
        return new Response(stream);
      }
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      const index = streams.length;
      if (request.method === "helloConversationV4")
        return Response.json({ result: hello(index) });
      if (request.method === "subscribeConversationV4") {
        const { sessionId } = request.args[0];
        const subscriptionId = `${sessionId}-${index}`;
        const value = snapshot(sessionId, index);
        for (const frame of protocol.encodeTopicWireFrames(
          {
            topic: `conversation/${sessionId}`,
            subscriptionId,
            fromSeq: 0,
            toSeq: index,
            sentAt: 1,
            payload: { kind: "snapshot", snapshot: value },
          },
          {
            deliveryKind: "initial",
            topic: `conversation/${sessionId}`,
            subscriptionId,
            logicalFrameId: subscriptionId,
            logicalFrameOrdinal: 1,
            measurePhysicalFrameBytes: (frame) =>
              encoder.encode(JSON.stringify(frame)).byteLength,
          },
        ))
          emit(index - 1, {
            event: "onDynamicConversationFrame",
            workspacePath: "/项目",
            frame,
          });
        return Response.json({
          result: {
            ack: { subscriptionId, mode: "snapshot", logEpoch: value.logEpoch },
          },
        });
      }
      return Response.json({
        result:
          request.method === "getView" ? { revision: index } : { commands: [] },
      });
    }),
  );
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  const layer = new SessionDataLayer({
    transport: createAgentConversationTransport(
      client.services.zcodeAgentService,
      { workspacePath: "/项目" },
    ),
    keepWarmMs: 0,
  });
  const main = layer.acquire("主");
  const child = layer.acquire("子");
  try {
    await vi.waitFor(() => expect(main.store.getState().status).toBe("live"));
    await vi.waitFor(() => expect(child.store.getState().status).toBe("live"));
    streams[0]!.close();
    await vi.waitFor(() => expect(main.store.getState().snapshot?.seq).toBe(2));
    await vi.waitFor(() =>
      expect(child.store.getState().snapshot?.seq).toBe(2),
    );
    expect(main.store.getState().snapshot?.rows.window).toMatchObject([
      { text: "主 正文 2" },
    ]);
    expect(child.store.getState().snapshot?.rows.window).toMatchObject([
      { text: "子 正文 2" },
    ]);
    child.release();
    await vi.waitFor(() =>
      expect(child.store.getState().status).toBe("closed"),
    );
    expect(main.store.getState().status).toBe("live");
    expect(
      requests
        .filter((item) => item.method === "subscribeConversationV4")
        .map((item) => {
          const target = item.args[0];
          if (!target) throw new Error("恢复订阅缺少原会话身份参数。");
          return [item.connectionId, target.sessionId];
        }),
    ).toEqual([
      ["owned-1", "主"],
      ["owned-1", "子"],
      ["owned-2", "主"],
      ["owned-2", "子"],
    ]);
  } finally {
    main.release();
    child.release();
    layer.dispose();
    client.dispose();
    streams.at(-1)?.close();
  }
});

it("Code 宿主断线自动换代，原服务收到恢复视图且同一客户端重新握手，关闭后停止重连", async () => {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  const initializations: Array<{ connectionId: string; args: unknown[] }> = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/events")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                event: "ready",
                hello: { connectionId: `connection-${streams.length}` },
              })}\n\n`,
            ),
          );
        },
      });
      return new Response(stream);
    }
    const input = JSON.parse(String(options?.body));
    if (input.method === "initializeConversationV4")
      initializations.push(input);
    return Response.json({
      result: input.method === "getView" ? { revision: streams.length } : {},
    });
  });
  vi.stubGlobal("fetch", fetcher);
  // 此测试只替身外部 HTTP 载体；监听和调用使用原服务代理。
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  const lifecycle = vi.fn();
  const view = vi.fn();
  client.services.zcodeAgentService.onDynamicConversationFrame({
    workspacePath: "/项目",
  })(() => {});
  const onAgentRuntimeLifecycle =
    client.services.zcodeAgentService.onAgentRuntimeLifecycle;
  if (!onAgentRuntimeLifecycle)
    throw new Error("Code 宿主未提供运行时生命周期订阅。");
  onAgentRuntimeLifecycle(lifecycle);
  client.services.providerSettingsService.onDidChange(view);
  try {
    await client.connect();
    const hello: protocol.ClientHello = {
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "stable-client",
      clientKind: "web",
      appVersion: "test",
    };
    await client.services.zcodeAgentService.initializeConversationV4(hello);
    streams[0]!.close();
    await vi.waitFor(() => expect(streams).toHaveLength(2), { timeout: 5000 });
    await vi.waitFor(() => expect(view).toHaveBeenCalledWith({ revision: 2 }));
    expect(
      lifecycle.mock.calls.map(([event]) => [event.workspaceKey, event.state]),
    ).toEqual([
      ["/项目", "unavailable"],
      ["/项目", "available"],
    ]);
    expect(initializations).toEqual([
      {
        connectionId: "connection-1",
        service: "zcodeAgentService",
        method: "initializeConversationV4",
        args: [hello],
      },
      {
        connectionId: "connection-2",
        service: "zcodeAgentService",
        method: "initializeConversationV4",
        args: [hello],
      },
    ]);
    client.dispose();
    streams[1]!.close();
    await Promise.resolve();
    expect(streams).toHaveLength(2);
  } finally {
    client.dispose();
  }
});
