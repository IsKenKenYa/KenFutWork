import { randomUUID } from "node:crypto";
import {
  type CodeUiEvent,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { CodeUiRepositoryError } from "./repository.js";

type Snapshot = protocol.ConversationSnapshot | protocol.SessionsIndexSnapshot;
interface Subscription {
  id: string;
  topic: string;
  workspacePath: string;
  ordinal: number;
  read: () => Promise<{ snapshot: Snapshot; seq: number }>;
}
interface Connection {
  owner: string;
  hello: protocol.HelloMessage;
  client: protocol.ClientHello | null;
  send: (event: CodeUiEvent) => Promise<void>;
  close: () => void;
  subscriptions: Map<string, Subscription>;
}

/** 连接只持有 owned 订阅；断线释放租约，权威会话与 Agent 运行独立存活。 */
export class CodeUiConnections {
  private readonly connections = new Map<string, Connection>();

  open(
    owner: string,
    userId: string,
    send: Connection["send"],
    close: () => void,
  ) {
    const hello = protocol.helloMessageSchema.parse({
      kind: "hello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      connectionId: randomUUID(),
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      serverTime: Date.now(),
      auth: { userId },
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
    });
    this.connections.set(hello.connectionId, {
      owner,
      hello,
      client: null,
      send,
      close,
      subscriptions: new Map(),
    });
    return {
      hello,
      dispose: () => this.connections.delete(hello.connectionId),
    };
  }

  closeAll() {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }

  async notify(
    owner: string,
    service: string,
    name: string,
    workspacePath: string,
    data: unknown,
  ) {
    for (const connection of this.connections.values()) {
      if (connection.owner === owner)
        await connection.send({
          event: "service",
          service,
          name,
          workspacePath,
          data,
        });
    }
  }

  require(owner: string, id: string | undefined, initialized = true) {
    const connection = id ? this.connections.get(id) : undefined;
    if (!connection || connection.owner !== owner)
      throw new CodeUiRepositoryError(
        "not_found",
        "Code 连接已关闭或不属于当前工作区",
      );
    if (initialized && !connection.client)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "Code 连接尚未完成原协议握手",
      );
    return connection;
  }

  initialize(owner: string, id: string | undefined, value: unknown) {
    const connection = this.require(owner, id, false);
    const client = protocol.clientHelloSchema.parse(value);
    if (connection.client && connection.client.clientId !== client.clientId)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "Code 连接已绑定另一个客户端",
      );
    connection.client = client;
  }

  async subscribe(
    owner: string,
    connectionId: string | undefined,
    target: Omit<Subscription, "id" | "ordinal">,
  ) {
    const connection = this.require(owner, connectionId);
    const initial = await target.read();
    const subscription: Subscription = {
      ...target,
      id: randomUUID(),
      ordinal: 0,
    };
    for (const [id, previous] of connection.subscriptions) {
      if (previous.topic === target.topic) connection.subscriptions.delete(id);
    }
    connection.subscriptions.set(subscription.id, subscription);
    return {
      result: {
        ack: {
          subscriptionId: subscription.id,
          mode: "snapshot" as const,
          logEpoch: initial.snapshot.logEpoch,
        },
      },
      // HTTP response finish 后发送；UI 原 ACK activation barrier 仍负责跨通道竞态。
      publish: () => this.emit(connection, subscription, initial, "initial"),
    };
  }

  async resync(
    owner: string,
    connectionId: string | undefined,
    value: protocol.ConversationResyncParams,
  ) {
    const connection = this.require(owner, connectionId);
    const subscription = connection.subscriptions.get(value.subscriptionId);
    if (!subscription)
      throw new CodeUiRepositoryError("not_found", "订阅不属于当前 Code 连接");
    const current = await subscription.read();
    return {
      result: {
        ack: {
          subscriptionId: subscription.id,
          mode: "snapshot" as const,
          logEpoch: current.snapshot.logEpoch,
        },
      },
      publish: () => this.emit(connection, subscription, current, "recovery"),
    };
  }

  unsubscribe(
    owner: string,
    connectionId: string | undefined,
    subscriptionId: string,
  ) {
    this.require(owner, connectionId).subscriptions.delete(subscriptionId);
  }

  async refresh(owner: string, workspacePath: string) {
    for (const connection of this.connections.values()) {
      if (connection.owner !== owner) continue;
      for (const subscription of connection.subscriptions.values()) {
        if (subscription.workspacePath !== workspacePath) continue;
        const current = await subscription.read();
        await this.emit(connection, subscription, current, "online");
      }
    }
  }

  private async emit(
    connection: Connection,
    subscription: Subscription,
    current: { snapshot: Snapshot; seq: number },
    deliveryKind: protocol.TopicFrameDeliveryKind,
  ) {
    if (connection.subscriptions.get(subscription.id) !== subscription) return;
    const conversation = subscription.topic.startsWith("conversation/");
    const frame = {
      topic: subscription.topic,
      subscriptionId: subscription.id,
      fromSeq: 0,
      toSeq: current.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot" as const, snapshot: current.snapshot },
    };
    const parsed = conversation
      ? protocol.conversationTopicFrameSchema.parse(frame)
      : protocol.sessionsIndexTopicFrameSchema.parse(frame);
    for (const wire of protocol.encodeTopicWireFrames(parsed, {
      deliveryKind,
      topic: subscription.topic,
      subscriptionId: subscription.id,
      logicalFrameId: randomUUID(),
      logicalFrameOrdinal: ++subscription.ordinal,
      measurePhysicalFrameBytes: (value) =>
        Buffer.byteLength(JSON.stringify(value), "utf8"),
    })) {
      await connection.send({
        event: conversation
          ? "onDynamicConversationFrame"
          : "onDynamicSessionsIndexFrame",
        workspacePath: subscription.workspacePath,
        frame: wire,
      } as CodeUiEvent);
    }
  }
}
