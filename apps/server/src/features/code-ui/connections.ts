import { randomUUID } from "node:crypto";
import {
  type CodeUiEvent,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { CodeUiRepositoryError } from "./repository.js";

type Snapshot =
  | protocol.ConversationSnapshot
  | protocol.SessionsIndexSnapshot
  | protocol.WorkspaceConfigSnapshot;
const topicDefinitions = [
  {
    prefix: "conversation/",
    event: "onDynamicConversationFrame",
    schema: protocol.conversationTopicFrameSchema,
  },
  {
    prefix: "sessions-index/",
    event: "onDynamicSessionsIndexFrame",
    schema: protocol.sessionsIndexTopicFrameSchema,
  },
  {
    prefix: "workspace-config/",
    event: "onDynamicWorkspaceConfigFrame",
    schema: protocol.workspaceConfigTopicFrameSchema,
  },
] as const;
interface Subscription {
  id: string;
  topic: string;
  workspacePath: string;
  /** 捕获原调用的路由identity；null显式表示path-only，不参与权限判定。 */
  workspaceIdentity?: string | null;
  projectId?: string;
  ordinal: number;
  cursor: { logEpoch: string; seq: number; retiredEpochs: Set<string> };
  read: () => Promise<{ snapshot: Snapshot; seq: number }>;
}
export interface CodeUiWorkspaceConfigRefreshFailure {
  connectionId: string;
  subscriptionId: string;
  workspacePath: string;
  projectId?: string;
  error: unknown;
  dispose(): void;
}
interface Connection {
  owner: string;
  hello: protocol.HelloMessage;
  client: protocol.ClientHello | null;
  send: (event: CodeUiEvent) => Promise<void>;
  close: () => void;
  subscriptions: Map<string, Subscription>;
  receivesNotifications: boolean;
}

/** 连接只持有 owned 订阅；断线释放租约，权威会话与 Agent 运行独立存活。 */
export class CodeUiConnections {
  private readonly connections = new Map<string, Connection>();

  open(
    owner: string,
    userId: string,
    send: Connection["send"],
    close: () => void,
    localTerminal = false,
    receivesNotifications = true,
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
        localTerminal,
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
      receivesNotifications,
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

  async send(owner: string, connectionId: string, event: CodeUiEvent) {
    await this.require(owner, connectionId, false).send(event);
  }

  async notify(
    owner: string,
    service: string,
    name: string,
    workspacePath: string,
    data: unknown,
    workspaceIdentity?: string,
  ) {
    for (const connection of this.connections.values()) {
      if (connection.owner === owner && connection.receivesNotifications)
        await connection.send({
          event: "service",
          service,
          name,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          data,
        });
    }
  }

  require(
    owner: string,
    id: string | undefined,
    initialized = true,
    userId?: string,
  ) {
    const connection = id ? this.connections.get(id) : undefined;
    if (
      !connection ||
      connection.owner !== owner ||
      (userId !== undefined && connection.hello.auth.userId !== userId)
    )
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
    target: Omit<Subscription, "id" | "ordinal" | "cursor">,
  ) {
    const connection = this.require(owner, connectionId);
    const initial = await target.read();
    if (this.connections.get(connection.hello.connectionId) !== connection)
      throw new CodeUiRepositoryError(
        "not_found",
        "Code连接在订阅准备期间已关闭。",
      );
    const subscription: Subscription = {
      ...target,
      id: randomUUID(),
      ordinal: 0,
      cursor: {
        logEpoch: initial.snapshot.logEpoch,
        seq: initial.seq,
        retiredEpochs: new Set(),
      },
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
    const current = await this.readOwned(connection, subscription);
    if (!this.isCurrentSnapshot(subscription, current))
      throw new CodeUiRepositoryError(
        "command_conflict",
        "Code订阅源已变化，请重新读取当前快照。",
      );
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

  requireSubscription(
    owner: string,
    connectionId: string,
    subscriptionId: string,
    topic: string,
  ) {
    const subscription = this.require(owner, connectionId).subscriptions.get(
      subscriptionId,
    );
    if (!subscription || subscription.topic !== topic)
      throw new CodeUiRepositoryError(
        "not_found",
        "订阅不属于当前Code连接与配置目标。",
      );
    return subscription;
  }

  async refreshWorkspaceConfig(owner: string, projectId?: string) {
    const failures: CodeUiWorkspaceConfigRefreshFailure[] = [];
    for (const connection of this.connections.values()) {
      if (connection.owner !== owner) continue;
      for (const subscription of connection.subscriptions.values()) {
        if (
          !subscription.topic.startsWith("workspace-config/") ||
          (projectId && subscription.projectId !== projectId)
        )
          continue;
        try {
          const current = await this.readOwned(connection, subscription);
          await this.emit(connection, subscription, current, "online");
        } catch (error) {
          failures.push({
            connectionId: connection.hello.connectionId,
            subscriptionId: subscription.id,
            workspacePath: subscription.workspacePath,
            ...(subscription.projectId
              ? { projectId: subscription.projectId }
              : {}),
            error,
            dispose: () => {
              if (
                connection.subscriptions.get(subscription.id) === subscription
              )
                connection.subscriptions.delete(subscription.id);
            },
          });
        }
      }
    }
    return failures;
  }

  async refresh(owner: string, workspacePath: string, projectId?: string) {
    for (const connection of this.connections.values()) {
      if (connection.owner !== owner) continue;
      for (const subscription of connection.subscriptions.values()) {
        if (subscription.topic.startsWith("workspace-config/")) continue;
        const sameProjectIndex =
          projectId !== undefined &&
          subscription.projectId === projectId &&
          !subscription.topic.startsWith("conversation/");
        if (subscription.workspacePath !== workspacePath && !sameProjectIndex)
          continue;
        const current = await this.readOwned(connection, subscription);
        await this.emit(connection, subscription, current, "online");
      }
    }
  }

  private owns(connection: Connection, subscription: Subscription) {
    return (
      this.connections.get(connection.hello.connectionId) === connection &&
      connection.subscriptions.get(subscription.id) === subscription
    );
  }

  private async readOwned(connection: Connection, subscription: Subscription) {
    const current = await subscription.read();
    if (!this.owns(connection, subscription))
      throw new CodeUiRepositoryError(
        "not_found",
        "Code订阅在读取期间已释放。",
      );
    const cursor = subscription.cursor;
    if (cursor.retiredEpochs.has(current.snapshot.logEpoch)) return current;
    if (cursor.logEpoch !== current.snapshot.logEpoch) {
      cursor.retiredEpochs.add(cursor.logEpoch);
      cursor.logEpoch = current.snapshot.logEpoch;
      cursor.seq = current.seq;
    } else {
      cursor.seq = Math.max(cursor.seq, current.seq);
    }
    return current;
  }

  private isCurrentSnapshot(
    subscription: Subscription,
    current: { snapshot: Snapshot; seq: number },
  ) {
    return (
      current.snapshot.logEpoch === subscription.cursor.logEpoch &&
      current.seq >= subscription.cursor.seq
    );
  }

  private async emit(
    connection: Connection,
    subscription: Subscription,
    current: { snapshot: Snapshot; seq: number },
    deliveryKind: protocol.TopicFrameDeliveryKind,
  ) {
    if (
      !this.owns(connection, subscription) ||
      !this.isCurrentSnapshot(subscription, current)
    )
      return;
    const definition = topicDefinitions.find((entry) =>
      subscription.topic.startsWith(entry.prefix),
    );
    if (!definition)
      throw new CodeUiRepositoryError("not_found", "未知的Code订阅主题。");
    const frame = {
      topic: subscription.topic,
      subscriptionId: subscription.id,
      fromSeq: 0,
      toSeq: current.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot" as const, snapshot: current.snapshot },
    };
    const parsed = definition.schema.parse(frame);
    const workspaceIdentity =
      subscription.workspaceIdentity === undefined && subscription.projectId
        ? JSON.stringify([subscription.projectId, subscription.workspacePath])
        : subscription.workspaceIdentity;
    for (const wire of protocol.encodeTopicWireFrames(parsed, {
      deliveryKind,
      topic: subscription.topic,
      subscriptionId: subscription.id,
      logicalFrameId: randomUUID(),
      logicalFrameOrdinal: ++subscription.ordinal,
      measurePhysicalFrameBytes: (value) =>
        Buffer.byteLength(JSON.stringify(value), "utf8"),
    })) {
      if (
        !this.owns(connection, subscription) ||
        !this.isCurrentSnapshot(subscription, current)
      )
        return;
      await connection.send({
        event: definition.event,
        workspacePath: subscription.workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        frame: wire,
      } as CodeUiEvent);
    }
  }
}
