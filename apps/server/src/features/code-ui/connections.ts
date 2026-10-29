import { randomUUID } from "node:crypto";
import {
  type CodeUiEvent,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type {
  CodeUiHostRpcCleanup,
  CodeUiHostRpcContext,
} from "./host-rpc-handler.js";
import { diffConversationSnapshots } from "./snapshot-diff.js";
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
  /** 会话租约绑定实际读取的Task授权代际，迟到移动不能释放后来的租约。 */
  taskScopeGeneration?: number;
  ordinal: number;
  cursor: { logEpoch: string; seq: number; retiredEpochs: Set<string> };
  /**
   * 上次成功推送的装饰后视图：online 帧优先对它做增量 diff（流式热路径从
   * 「每帧重发整个会话」变为「只发变化」）；deltas 发送成功后推进，发送失败
   * 不推进——客户端按 fromSeq 衔接判定断档，走既有 resync 全量自愈。
   */
  lastPushed?: ConversationSnapshot | undefined;
  read: () => Promise<{
    snapshot: Snapshot;
    seq: number;
    taskScopeGeneration?: number;
  }>;
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
  accessClientId: string | null;
  hello: protocol.HelloMessage;
  client: protocol.ClientHello | null;
  send: (event: CodeUiEvent) => Promise<void>;
  close: () => void;
  subscriptions: Map<string, Subscription>;
  retiredTaskGenerations: Map<string, number>;
  receivesNotifications: boolean;
  abort: AbortController;
  cleanups: Set<CodeUiHostRpcCleanup>;
  disposal?: Promise<void>;
}

function taskSubscriptionKey(projectId: string, topic: string) {
  return JSON.stringify([projectId, topic]);
}

/** 连接只持有 owned 订阅；断线释放租约，权威会话与 Agent 运行独立存活。 */
export class CodeUiConnections {
  private readonly connections = new Map<string, Connection>();
  private readonly disposals = new Set<Promise<void>>();

  open(
    owner: string,
    userId: string,
    send: Connection["send"],
    close: () => void,
    localTerminal = false,
    receivesNotifications = true,
    accessClientId: string | null = null,
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
        // 独立计划态：宿主已支持（createSession.firstInput.planEnabled 进 record、运行期按
        // planEnabled 走计划门），但握手必须**显式宣告**——vendored 客户端只在见到该位时
        // 才允许发送带 Plan 的创建命令（否则抛 proto.independentPlanUnsupported，
        // 表现为「勾了计划模式 → 发送失败」，而取消计划立即成功）。
        independentPlanState: true,
      },
    });
    const connection: Connection = {
      owner,
      accessClientId,
      hello,
      client: null,
      send,
      close,
      subscriptions: new Map(),
      retiredTaskGenerations: new Map(),
      receivesNotifications,
      abort: new AbortController(),
      cleanups: new Set(),
    };
    this.connections.set(hello.connectionId, connection);
    return {
      hello,
      dispose: () => this.dispose(connection),
    };
  }

  async closeAll() {
    const connections = [...this.connections.values()];
    for (const connection of connections) this.dispose(connection);
    const transports = connections.map(async (connection) => {
      connection.close();
    });
    await this.waitForDisposals([...this.disposals, ...transports]);
  }

  retireTaskSubscriptions(
    owner: string,
    taskIds: readonly string[],
    sourceProjectId: string,
    scopeGeneration: number,
  ): void {
    const topics = new Set(taskIds.map(protocol.conversationTopic));
    for (const connection of this.connections.values()) {
      if (connection.owner !== owner) continue;
      for (const topic of topics) {
        const key = taskSubscriptionKey(sourceProjectId, topic);
        const previous = connection.retiredTaskGenerations.get(key);
        if (previous === undefined || previous < scopeGeneration)
          connection.retiredTaskGenerations.set(key, scopeGeneration);
      }
      for (const [id, subscription] of connection.subscriptions) {
        if (
          subscription.projectId === sourceProjectId &&
          subscription.taskScopeGeneration !== undefined &&
          subscription.taskScopeGeneration <= scopeGeneration &&
          topics.has(subscription.topic)
        )
          connection.subscriptions.delete(id);
      }
    }
  }

  context(
    owner: string,
    id: string | undefined,
    accessClientId: string | null,
  ): CodeUiHostRpcContext {
    const connection = this.require(owner, id, false, accessClientId);
    const connectionId = connection.hello.connectionId;
    return Object.freeze({
      actor: Object.freeze({
        instanceId: connection.owner,
        accessClientId: connection.accessClientId,
      }),
      connectionId,
      signal: connection.abort.signal,
      requireInitialized: () => {
        this.require(owner, connectionId, true, accessClientId);
      },
      onClose: (cleanup: CodeUiHostRpcCleanup) => {
        this.require(owner, connectionId, false, accessClientId);
        connection.cleanups.add(cleanup);
        return () => {
          connection.cleanups.delete(cleanup);
        };
      },
    });
  }

  private dispose(connection: Connection): Promise<void> {
    if (connection.disposal) return connection.disposal;
    this.connections.delete(connection.hello.connectionId);
    connection.retiredTaskGenerations.clear();
    connection.disposal = Promise.resolve().then(async () => {
      const cleanups = [...connection.cleanups];
      connection.cleanups.clear();
      await this.waitForDisposals(
        cleanups.map(async (cleanup) => {
          await cleanup();
        }),
      );
    });
    const disposal = connection.disposal;
    this.disposals.add(disposal);
    void disposal.then(
      () => this.disposals.delete(disposal),
      () => this.disposals.delete(disposal),
    );
    connection.abort.abort();
    return disposal;
  }

  private async waitForDisposals(disposals: Promise<void>[]): Promise<void> {
    const failures = (await Promise.allSettled(disposals)).flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Code连接资源尚未全部确认关闭。");
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
    await this.notifyEvent(owner, {
      event: "service",
      service,
      name,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      data,
    });
  }

  async notifyEvent(owner: string, event: CodeUiEvent) {
    for (const connection of this.connections.values()) {
      if (connection.owner === owner && connection.receivesNotifications)
        await connection.send(event);
    }
  }

  require(
    owner: string,
    id: string | undefined,
    initialized = true,
    accessClientId?: string | null,
  ) {
    const connection = id ? this.connections.get(id) : undefined;
    if (
      !connection ||
      connection.owner !== owner ||
      (accessClientId !== undefined &&
        connection.accessClientId !== accessClientId)
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
    target: Omit<
      Subscription,
      "id" | "ordinal" | "cursor" | "taskScopeGeneration"
    >,
  ) {
    const connection = this.require(owner, connectionId);
    const initial = await target.read();
    if (this.connections.get(connection.hello.connectionId) !== connection)
      throw new CodeUiRepositoryError(
        "not_found",
        "Code连接在订阅准备期间已关闭。",
      );
    const retiredGeneration = target.projectId
      ? connection.retiredTaskGenerations.get(
          taskSubscriptionKey(target.projectId, target.topic),
        )
      : undefined;
    if (
      retiredGeneration !== undefined &&
      (initial.taskScopeGeneration === undefined ||
        initial.taskScopeGeneration <= retiredGeneration)
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "任务已移动，请重新打开任务。",
      );
    const subscription: Subscription = {
      ...target,
      id: randomUUID(),
      ...(initial.taskScopeGeneration === undefined
        ? {}
        : { taskScopeGeneration: initial.taskScopeGeneration }),
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
    // 并发 refresh 的交错读取：比已推送视图更旧的读作废（新读已覆盖它的事实）。
    // 等值不拦：同 seq 的 recovery 必须照常交付，重复 online 帧由客户端水位去重。
    if (
      subscription.lastPushed &&
      current.seq < subscription.lastPushed.seq
    )
      return;
    const definition = topicDefinitions.find((entry) =>
      subscription.topic.startsWith(entry.prefix),
    );
    if (!definition)
      throw new CodeUiRepositoryError("not_found", "未知的Code订阅主题。");
    // 增量 diff 只对 conversation topic 定义（其余 topic 的快照结构不同）：
    // online 且持有上次视图时优先 deltas；无法表达（epoch 换代/结构变化/零差异）
    // 一律退化为整体快照——客户端对两种帧的语义都已内建。
    const conversationSnapshot =
      definition.prefix === "conversation/"
        ? (current.snapshot as ConversationSnapshot)
        : null;
    const previous = subscription.lastPushed;
    const diffResult =
      deliveryKind === "online" &&
      conversationSnapshot !== null &&
      previous &&
      previous.logEpoch === conversationSnapshot.logEpoch
        ? diffConversationSnapshots(previous, conversationSnapshot)
        : null;
    const frame = {
      topic: subscription.topic,
      subscriptionId: subscription.id,
      fromSeq: previous?.seq ?? 0,
      toSeq: current.seq,
      sentAt: Date.now(),
      payload:
        diffResult && !diffResult.fallbackToSnapshot
          ? { kind: "deltas" as const, deltas: diffResult.deltas }
          : { kind: "snapshot" as const, snapshot: current.snapshot },
    };
    const parsed = definition.schema.parse(frame);
    const workspaceIdentity =
      subscription.workspaceIdentity === undefined && subscription.projectId
        ? JSON.stringify([subscription.projectId, subscription.workspacePath])
        : subscription.workspaceIdentity;
    const notification = (wire: unknown) => ({
      event: definition.event,
      workspacePath: subscription.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      frame: wire,
    });
    for (const wire of protocol.encodeTopicWireFrames(parsed, {
      deliveryKind,
      topic: subscription.topic,
      subscriptionId: subscription.id,
      logicalFrameId: randomUUID(),
      logicalFrameOrdinal: ++subscription.ordinal,
      measurePhysicalFrameBytes: (value) =>
        Math.max(
          protocol.measureTopicNotificationEnvelopeBytes(value).maxBytes,
          Buffer.byteLength(JSON.stringify(notification(value)), "utf8"),
        ),
    })) {
      if (
        !this.owns(connection, subscription) ||
        !this.isCurrentSnapshot(subscription, current)
      )
        return;
      await connection.send(notification(wire) as CodeUiEvent);
    }
    // 全部物理片发送成功才推进已推送视图；中途失败由客户端断档自愈兜底。
    // 仅 conversation topic 维护该视图，其余 topic 保持原有行为。
    if (conversationSnapshot !== null) {
      subscription.lastPushed = conversationSnapshot;
    }
  }
}
