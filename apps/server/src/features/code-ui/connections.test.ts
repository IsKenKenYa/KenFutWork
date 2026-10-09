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
