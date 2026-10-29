import { randomUUID } from "node:crypto";
import {
  type CodeUiEvent,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { CodeUiConnections } from "./connections.js";
import { createCodeUiConversation } from "./conversation.js";

const topicKinds = [
  "conversation",
  "sessions-index",
  "workspace-config",
] as const;

it("连接关闭立即取消贡献工作并等待登记的异步清理", async () => {
  const connections = new CodeUiConnections();
  const owner = randomUUID();
  const accessClientId = randomUUID();
  const carrier = connections.open(
    owner,
    owner,
    async () => {},
    () => {},
    false,
    true,
    accessClientId,
  );
  const context = connections.context(
    owner,
    carrier.hello.connectionId,
    accessClientId,
  );
  let releaseCleanup = () => {};
  const cleanupReady = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let cleanupFinished = false;
  context.onClose(async () => {
    await cleanupReady;
    cleanupFinished = true;
  });
  let closed = false;
  const closing = carrier.dispose().then(() => {
    closed = true;
  });
  expect(context.signal.aborted).toBe(true);
  expect(() =>
    connections.require(owner, carrier.hello.connectionId, false),
  ).toThrow("Code 连接已关闭");
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(cleanupFinished).toBe(false);
  releaseCleanup();
  await closing;
  expect(cleanupFinished).toBe(true);
  expect(closed).toBe(true);
});

it("贡献上下文保留只读实例与客户端身份并按当前握手状态校验", async () => {
  const connections = new CodeUiConnections();
  const owner = randomUUID();
  const accessClientId = randomUUID();
  const carrier = connections.open(
    owner,
    owner,
    async () => {},
    () => {},
    false,
    true,
    accessClientId,
  );
  const context = connections.context(
    owner,
    carrier.hello.connectionId,
    accessClientId,
  );
  expect(context.actor).toEqual({ instanceId: owner, accessClientId });
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.actor)).toBe(true);
  expect(context).not.toHaveProperty("taskId");
  expect(() =>
    connections.context(randomUUID(), context.connectionId, accessClientId),
  ).toThrow("Code 连接已关闭");
  expect(() =>
    connections.context(owner, context.connectionId, randomUUID()),
  ).toThrow("Code 连接已关闭");
  expect(() => context.requireInitialized()).toThrow("尚未完成原协议握手");
  connections.initialize(owner, context.connectionId, {
    kind: "clientHello",
    protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
    clientId: randomUUID(),
    appVersion: "test",
    clientKind: "web",
  });
  expect(() => context.requireInitialized()).not.toThrow();
  await carrier.dispose();
  expect(() => context.requireInitialized()).toThrow("Code 连接已关闭");
  expect(() => context.onClose(async () => {})).toThrow("Code 连接已关闭");
});

it("关闭全部连接会等待此前已释放连接的在途清理", async () => {
  const connections = new CodeUiConnections();
  const owner = randomUUID();
  const carrier = connections.open(
    owner,
    owner,
    async () => {},
    () => {},
  );
  let releaseCleanup = () => {};
  const cleanupReady = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  connections
    .context(owner, carrier.hello.connectionId, null)
    .onClose(async () => {
      await cleanupReady;
    });
  const disposed = carrier.dispose();
  let allClosed = false;
  const closing = connections.closeAll().then(() => {
    allClosed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(allClosed).toBe(false);
  } finally {
    releaseCleanup();
    await Promise.all([disposed, closing]);
  }
  expect(allClosed).toBe(true);
});

it("传输关闭回调抛错后仍关闭其他连接并等待清理且保留全部错误", async () => {
  const connections = new CodeUiConnections();
  const owner = randomUUID();
  const closeFailure = new Error("传输关闭失败");
  const cleanupFailure = new Error("资源清理失败");
  connections.open(
    owner,
    owner,
    async () => {},
    () => {
      throw closeFailure;
    },
  );
  let secondTransportClosed = false;
  const second = connections.open(
    owner,
    owner,
    async () => {},
    () => {
      secondTransportClosed = true;
    },
  );
  let releaseCleanup = () => {};
  const cleanupReady = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  connections
    .context(owner, second.hello.connectionId, null)
    .onClose(async () => {
      await cleanupReady;
      throw cleanupFailure;
    });
  let finished = false;
  let failure: unknown;
  const closing = connections.closeAll().then(
    () => {
      finished = true;
    },
    (error: unknown) => {
      finished = true;
      failure = error;
    },
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondTransportClosed).toBe(true);
    expect(finished).toBe(false);
  } finally {
    releaseCleanup();
    await closing;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({
    errors: expect.arrayContaining([
      closeFailure,
      expect.objectContaining({ errors: [cleanupFailure] }),
    ]),
  });
});

it("文档通知只发送给同实例活动通知连接；不要求Task订阅或V4握手", async () => {
  const connections = new CodeUiConnections();
  const owner = randomUUID();
  const deliveries: string[] = [];
  const open = (instanceId: string, id: string, receivesNotifications = true) =>
    connections.open(
      instanceId,
      instanceId,
      async () => {
        deliveries.push(id);
      },
      () => {},
      false,
      receivesNotifications,
    );
  const first = open(owner, "first");
  open(owner, "second");
  open(randomUUID(), "foreign");
  open(owner, "control-only", false);
  const revoked = open(owner, "revoked");
  revoked.dispose();
  const event: CodeUiEvent = {
    event: "canvasDocumentUpdated",
    data: {
      type: "canvas.document.updated",
      canvasId: randomUUID(),
      projectId: randomUUID(),
      deleted: false,
    },
  };
  await connections.notifyEvent(owner, event);
  expect(deliveries).toEqual(["first", "second"]);
  first.dispose();
  await connections.notifyEvent(owner, event);
  expect(deliveries).toEqual(["first", "second", "second"]);
});

function fixture(kind: (typeof topicKinds)[number]) {
  const owner = randomUUID();
  const projectId = randomUUID();
  const path = "/owned/project";
  const identity = JSON.stringify([projectId, path]);
  const task = createCodeUiConversation({
    sessionId: randomUUID(),
    workspacePath: path,
    config: {
      provider: "fixture-provider",
      model: "fixture-model",
      thought: "",
      followupMode: "queue",
      mode: "build",
    },
  });
  const connections = new CodeUiConnections();
  const events: CodeUiEvent[] = [];
  const carrier = connections.open(
    owner,
    randomUUID(),
    async (event) => {
      events.push(event);
    },
    () => {},
  );
  const connectionId = carrier.hello.connectionId;
  connections.initialize(owner, connectionId, {
    kind: "clientHello",
    protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
    clientId: randomUUID(),
    appVersion: "test",
    clientKind: "web",
  });
  const topic =
    kind === "conversation"
      ? protocol.conversationTopic(task.getSnapshot().sessionId)
      : kind === "sessions-index"
        ? protocol.sessionsIndexTopic(identity)
        : protocol.workspaceConfigTopic(identity);
  let source = { logEpoch: randomUUID(), seq: 0 };
  const read = async () => {
    const snapshot =
      kind === "conversation"
        ? protocol.conversationSnapshotSchema.parse({
            ...task.getSnapshot(),
            logEpoch: source.logEpoch,
            seq: source.seq,
            revision: source.seq,
          })
        : kind === "sessions-index"
          ? protocol.sessionsIndexSnapshotSchema.parse({
              protocolVersion: 1,
              workspaceId: identity,
              logEpoch: source.logEpoch,
              sessions: [],
            })
          : protocol.workspaceConfigSnapshotSchema.parse({
              protocolVersion: 1,
              workspaceId: identity,
              logEpoch: source.logEpoch,
              config: {
                configOptions: [
                  {
                    id: "mode",
                    name: "Mode",
                    type: "select",
                    currentValue: "build",
                    options: [{ value: "build", name: "Ask before changes" }],
                  },
                ],
                slashCommands: [],
              },
            });
    return { snapshot, seq: source.seq };
  };
  return {
    owner,
    connectionId,
    connections,
    events,
    subscribe: () =>
      connections.subscribe(owner, connectionId, {
        topic,
        workspacePath: path,
        workspaceIdentity: identity,
        projectId,
        read,
      }),
    refresh: () =>
      kind === "workspace-config"
        ? connections.refreshWorkspaceConfig(owner)
        : connections.refresh(owner, path, projectId),
    setSource: (next: typeof source) => {
      source = next;
    },
    source: () => ({ ...source }),
    mutateHost: (mutate: (host: typeof task) => void) => mutate(task),
    readCurrentSnapshot: async () => {
      if (kind !== "conversation")
        throw new Error("readCurrentSnapshot 仅conversation夹具支持");
      return protocol.conversationSnapshotSchema.parse({
        ...(await read()).snapshot,
        logEpoch: source.logEpoch,
        seq: source.seq,
        revision: source.seq,
      });
    },
  };
}

function frame(event: CodeUiEvent | undefined) {
  if (!event || !("frame" in event)) throw new Error("缺少真实topic frame。");
  const wire = protocol.routedTopicWireFrameSchema.parse(event.frame);
  if (wire.kind !== "complete") throw new Error("小型夹具意外分片。");
  if (wire.frame.payload.kind !== "snapshot")
    throw new Error("缺少完整snapshot。");
  return { wire, frame: wire.frame, snapshot: wire.frame.payload.snapshot };
}

it.each([790_000, 1_600_000])(
  "%i字节会话的initial与强制recovery必须被原前端assembler接受",
  async (size) => {
    const f = fixture("conversation");
    const host = createCodeUiConversation({
      sessionId: randomUUID(),
      workspacePath: "/owned/project",
      config: {
        provider: "fixture",
        model: "fixture",
        thought: "",
        followupMode: "queue",
        mode: "build",
      },
    });
    const snapshot = protocol.conversationSnapshotSchema.parse({
      ...host.getSnapshot(),
      meta: { title: "x".repeat(size), titleSource: "generated" },
    });
    const topic = protocol.conversationTopic(snapshot.sessionId);
    const subscription = await f.connections.subscribe(
      f.owner,
      f.connectionId,
      {
        topic,
        workspacePath: "/owned/project",
        read: async () => ({ snapshot, seq: snapshot.seq }),
      },
    );
    await subscription.publish();
    const check = (delivery: "initial" | "recovery") => {
      const assembler = new protocol.TopicWireFrameAssembler(
        protocol.conversationTopicFrameSchema,
      );
      const outcomes = f.events.flatMap((event) =>
        "frame" in event
          ? assembler.accept(
              protocol.conversationTopicWireCandidateSchema.parse(event.frame),
            )
          : [],
      );
      expect(
        outcomes
          .filter((event) => event.kind === "fault")
          .map((event) =>
            event.kind === "fault" ? event.fault.reasonCode : null,
          ),
      ).toEqual([]);
      const complete = outcomes.find((event) => event.kind === "complete");
      if (!complete || complete.kind !== "complete")
        throw new Error("订阅没有完整logical frame");
      expect(complete.deliveryKind).toBe(delivery);
      expect(complete.frame.payload.kind).toBe("snapshot");
      for (const event of f.events)
        expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(
          protocol.PROTOCOL_V4_LIMITS.maxFrameBytes,
        );
    };
    check("initial");
    f.events.length = 0;
    const recovered = await f.connections.resync(f.owner, f.connectionId, {
      subscriptionId: subscription.result.ack.subscriptionId,
      base: null,
      forceSnapshot: true,
    });
    await recovered.publish();
    check("recovery");
  },
);

it.each(topicKinds)(
  "%s：最新online已发后，迟到initial/recovery不得回滚；同seq recovery仍交付",
  async (kind) => {
    const f = fixture(kind);
    const subscribed = await f.subscribe();
    f.setSource({ ...f.source(), seq: 1 });
    await f.refresh();
    expect(frame(f.events[0]).frame.toSeq).toBe(1);
    await subscribed.publish();
    expect(f.events).toHaveLength(1);
    const recovered = await f.connections.resync(f.owner, f.connectionId, {
      subscriptionId: subscribed.result.ack.subscriptionId,
      base: { logEpoch: f.source().logEpoch, seq: 0 },
    });
    f.setSource({ ...f.source(), seq: 2 });
    await f.refresh();
    await recovered.publish();
    expect(f.events).toHaveLength(2);
    const aligned = await f.connections.resync(f.owner, f.connectionId, {
      subscriptionId: subscribed.result.ack.subscriptionId,
      base: { logEpoch: f.source().logEpoch, seq: 2 },
    });
    await aligned.publish();
    expect(f.events).toHaveLength(3);
    expect(frame(f.events[2]).wire.deliveryKind).toBe("recovery");
    expect(frame(f.events[2]).frame.toSeq).toBe(2);
  },
);

it.each(topicKinds)(
  "%s：新source epoch允许seq归零，旧epoch迟到initial/recovery不能覆盖新态",
  async (kind) => {
    const f = fixture(kind);
    const subscribed = await f.subscribe();
    const originalEpoch = f.source().logEpoch;
    const firstReplacement = { logEpoch: randomUUID(), seq: 0 };
    f.setSource(firstReplacement);
    await f.refresh();
    expect(frame(f.events[0]).snapshot.logEpoch).toBe(
      firstReplacement.logEpoch,
    );
    await subscribed.publish();
    expect(f.events).toHaveLength(1);
    expect(frame(f.events[0]).snapshot.logEpoch).not.toBe(originalEpoch);
    const recovered = await f.connections.resync(f.owner, f.connectionId, {
      subscriptionId: subscribed.result.ack.subscriptionId,
      base: { logEpoch: firstReplacement.logEpoch, seq: 0 },
    });
    const nextEpoch = { logEpoch: randomUUID(), seq: 0 };
    f.setSource(nextEpoch);
    await f.refresh();
    await recovered.publish();
    expect(f.events).toHaveLength(2);
    expect(frame(f.events[1]).snapshot.logEpoch).toBe(nextEpoch.logEpoch);
    expect(frame(f.events[1]).frame.toSeq).toBe(0);
    f.setSource({ ...firstReplacement, seq: 5 });
    await f.refresh();
    expect(f.events).toHaveLength(2);
  },
);

it("hello 宣告 independentPlanState：vendored 客户端只在见到该位时允许发送 Plan 创建命令", () => {
  const connections = new CodeUiConnections();
  const carrier = connections.open(
    randomUUID(),
    randomUUID(),
    async () => {},
    () => {},
  );
  // 回归：此前缺这一位，勾选「计划」后发送在客户端被拒（proto.independentPlanUnsupported），
  // 表现为「计划模式 → 发送失败」，取消计划立即成功。
  expect(carrier.hello.capabilities.independentPlanState).toBe(true);
});

it("conversation 订阅的流式刷新推送 deltas 帧且逐帧衔接，可由真实 apply 复原", async () => {
  const f = fixture("conversation");
  const subscribed = await f.subscribe();
  await subscribed.publish();
  expect(f.events).toHaveLength(1);
  const initial = frame(f.events[0]);

  // 两条流式 delta：快照从空窗进入一条增长中的 assistantText 行。
  // fixture 的 read 水位来自 source，真实服务端每事件 +1，这里同步推进。
  const runId = randomUUID();
  const at = new Date().toISOString();
  f.setSource({ logEpoch: f.source().logEpoch, seq: 1 });
  f.mutateHost((host) => {
    host.recordEvent({
      type: "message.delta",
      runId,
      messageId: "m-1",
      delta: "你好",
      timestamp: at,
    });
  });
  await f.refresh();
  f.setSource({ logEpoch: f.source().logEpoch, seq: 2 });
  f.mutateHost((host) => {
    host.recordEvent({
      type: "message.delta",
      runId,
      messageId: "m-1",
      delta: "，世界",
      timestamp: at,
    });
  });
  await f.refresh();
  expect(f.events).toHaveLength(3);

  const deltasFrame = (index: number) => {
    const event = f.events[index];
    if (!event || !("frame" in event)) throw new Error("缺少topic frame。");
    const wire = protocol.routedTopicWireFrameSchema.parse(event.frame);
    if (wire.kind !== "complete") throw new Error("意外分片。");
    if (wire.frame.payload.kind !== "deltas")
      throw new Error(`期望deltas帧，实际 ${wire.frame.payload.kind}`);
    return wire.frame;
  };
  const first = deltasFrame(1);
  const second = deltasFrame(2);
  expect(first.fromSeq).toBe(initial.frame.toSeq);
  expect(second.fromSeq).toBe(first.toSeq);

  // 客户端语义复检：initial snapshot 逐帧应用 deltas 必须等于当前权威读数。
  // @kenfutwork/shared 与 @zcode/shared/zcode-protocol-v4 是同一 schema 的两份
  // 导出，先 parse 归一到 apply 侧的包类型再应用。
  const baseSnapshot = protocol.conversationSnapshotSchema.parse(
    initial.snapshot,
  );
  const latest = await f.readCurrentSnapshot();
  const { applyConversationDeltas } = await import(
    "@zcode/shared/zcode-protocol-v4"
  );
  const applied = applyConversationDeltas(baseSnapshot, [
    ...(first.payload.kind === "deltas" ? first.payload.deltas : []),
    ...(second.payload.kind === "deltas" ? second.payload.deltas : []),
    // 两包协议是同一 schema 的新旧两份导出（@kenfutwork/shared 少 workflowRun.*）；
    // diff 只产两边共有的 5 个基础 op，运行时兼容，类型边界在此归一。
  ] as Parameters<typeof applyConversationDeltas>[1]);
  expect({ ...applied, seq: latest.seq }).toEqual(latest);

  // epoch 换代后退化为整体 snapshot（增量不跨 epoch）。
  f.setSource({ logEpoch: randomUUID(), seq: f.source().seq + 1 });
  await f.refresh();
  expect(f.events).toHaveLength(4);
  expect(frame(f.events[3]).wire.deliveryKind).toBe("online");
  expect(frame(f.events[3]).snapshot.logEpoch).not.toBe(initial.snapshot.logEpoch);
});
