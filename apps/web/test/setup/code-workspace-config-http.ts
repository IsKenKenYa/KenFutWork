import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";

export const configProjectId = "31000000-0000-4000-8000-000000000031";
export const configProjectPath = "/配置/共享根";
export const configProjectIdentity = JSON.stringify([
  configProjectId,
  configProjectPath,
]);
export const configWorkspace = {
  projectId: configProjectId,
  path: configProjectPath,
  name: "配置项目",
  additionalDirectories: [],
};

interface Rpc {
  service: string;
  method: string;
  connectionId: string;
  args: Array<{
    workspacePath?: string;
    workspaceIdentity?: string;
    projectId?: string;
    subscriptionId?: string;
  }>;
}

/** 外部HTTP/SSE边界；原typed proxy、ACK barrier、Project lease与UI store均真实运行。 */
export function createWorkspaceConfigHttpFixture() {
  const encoder = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const closedStreams = new Set<number>();
  const requests: Rpc[] = [];
  const subscriptions = new Map<
    string,
    { connection: number; target: Rpc["args"][number]; ordinal: number }
  >();
  let config = protocol.workspaceConfigStateSchema.parse({
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "provider/default-B$high",
        options: [
          {
            value: "provider/default-B",
            name: "默认B",
            modelProviderId: "provider",
            modelThoughtLevels: ["low", "high"],
          },
        ],
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "build",
        options: [{ value: "build", name: "Ask before changes" }],
      },
    ],
    slashCommands: [
      { name: "inspect", description: "真实检查命令", source: "custom" },
    ],
  });
  let seq = 0;
  let nextSubscriptionId = 0;
  let holdNextAck = false;
  let subscribeFailure: string | null = null;
  let replaceRecoveryWithOnline = false;
  const pendingAcks = new Map<string, () => void>();
  const hello = (index: number) =>
    protocol.helloMessageSchema.parse({
      kind: "hello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      connectionId: `config-connection-${index}`,
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      serverTime: 1,
      auth: {},
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
    });
  const send = (index: number, data: unknown) => {
    const stream = streams[index];
    if (!stream) throw new Error("配置测试通知连接尚未建立。");
    stream.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };
  const packets = (
    subscriptionId: string,
    deliveryKind: protocol.TopicFrameDeliveryKind,
  ) => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) throw new Error("测试配置订阅不存在。");
    const target = subscription.target;
    const identity = target.workspaceIdentity ?? target.workspacePath ?? "";
    const topic = protocol.workspaceConfigTopic(identity);
    const logical = protocol.workspaceConfigTopicFrameSchema.parse({
      topic,
      subscriptionId,
      fromSeq: 0,
      toSeq: seq,
      sentAt: 1,
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          workspaceId: identity,
          logEpoch: "config-epoch",
          config,
        },
      },
    });
    return protocol
      .encodeTopicWireFrames(logical, {
        deliveryKind,
        topic,
        subscriptionId,
        logicalFrameId: `${subscriptionId}-${++subscription.ordinal}`,
        logicalFrameOrdinal: subscription.ordinal,
        measurePhysicalFrameBytes: (value) =>
          encoder.encode(JSON.stringify(value)).byteLength,
      })
      .map((frame) => ({
        event: "onDynamicWorkspaceConfigFrame",
        ...target,
        frame,
      }));
  };
  const publish = (
    subscriptionId: string,
    deliveryKind: protocol.TopicFrameDeliveryKind,
  ) => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) throw new Error("测试配置订阅不存在。");
    for (const packet of packets(subscriptionId, deliveryKind))
      send(subscription.connection, packet);
  };
  const disconnect = (index: number) => {
    if (closedStreams.has(index)) return;
    closedStreams.add(index);
    for (const [id, subscription] of subscriptions) {
      if (subscription.connection === index) subscriptions.delete(id);
    }
    streams[index]?.close();
  };
  return {
    requests,
    subscriptions,
    capture: (id: string) => packets(id, "online"),
    send,
    disconnect,
    holdNextSubscribeAck() {
      holdNextAck = true;
    },
    failNextSubscribe(message: string) {
      subscribeFailure = message;
    },
    onlineSnapshotReplacesNextRecovery() {
      replaceRecoveryWithOnline = true;
    },
    releaseSubscribeAck(id: string) {
      const release = pendingAcks.get(id);
      if (!release) throw new Error("外部测试ACK没有处于pending。");
      pendingAcks.delete(id);
      release();
    },
    setSource(next: protocol.WorkspaceConfigState) {
      config = protocol.workspaceConfigStateSchema.parse(next);
      seq += 1;
    },
    fetch: async (url: string, options?: RequestInit) => {
      if (url.endsWith("/events"))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const index = streams.push(controller) - 1;
              send(index, {
                event: "ready",
                hello: hello(index),
                reconnectDelayMs: 100,
              });
              options?.signal?.addEventListener(
                "abort",
                () => disconnect(index),
                { once: true },
              );
            },
          }),
        );
      const request: Rpc = JSON.parse(String(options?.body));
      requests.push(request);
      if (request.method === "helloConversationV4")
        return Response.json({ result: hello(streams.length - 1) });
      if (request.method === "readWorkspacePresentation")
        return Response.json({
          result: {
            workspace: {
              workspacePath: request.args[0]?.workspacePath,
              workspaceKey: request.args[0]?.workspacePath,
            },
            mode: "build",
            slashCommands: config.slashCommands,
          },
        });
      if (request.method === "subscribeWorkspaceConfigV4") {
        if (subscribeFailure) {
          const message = subscribeFailure;
          subscribeFailure = null;
          return Response.json({ error: { message } }, { status: 503 });
        }
        const id = `workspace-config-${++nextSubscriptionId}`;
        subscriptions.set(id, {
          connection: streams.length - 1,
          target: request.args[0] ?? {},
          ordinal: 0,
        });
        // 在ACK Promise continuation前发布，真实consumer必须先挂listener并通过原barrier激活。
        publish(id, "initial");
        if (holdNextAck) {
          holdNextAck = false;
          await new Promise<void>((resolve) => {
            pendingAcks.set(id, resolve);
          });
        }
        return Response.json({
          result: protocol.v4WorkspaceConfigSubscribeResultSchema.parse({
            ack: {
              subscriptionId: id,
              mode: "snapshot",
              logEpoch: "config-epoch",
            },
          }),
        });
      }
      if (request.method === "resyncWorkspaceConfigV4") {
        const id = request.args[0]?.subscriptionId ?? "";
        if (replaceRecoveryWithOnline) {
          replaceRecoveryWithOnline = false;
          publish(id, "online");
        } else publish(id, "recovery");
        return Response.json({
          result: {
            ack: {
              subscriptionId: id,
              mode: "snapshot",
              logEpoch: "config-epoch",
            },
          },
        });
      }
      if (request.method === "unsubscribeWorkspaceConfigV4")
        subscriptions.delete(request.args[0]?.subscriptionId ?? "");
      return Response.json({ result: null });
    },
    update(next: protocol.WorkspaceConfigState) {
      config = protocol.workspaceConfigStateSchema.parse(next);
      seq += 1;
      for (const id of subscriptions.keys()) publish(id, "online");
    },
  };
}
