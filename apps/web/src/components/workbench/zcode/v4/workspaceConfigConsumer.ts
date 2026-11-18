import type { IZCodeAgentService } from "@zcode/services";
import {
  type TopicFrameDeliveryKind,
  type TopicWireAssemblyFault,
  TopicWireFrameAssembler,
  v4ConversationResyncResultSchema,
  v4WorkspaceConfigSubscribeResultSchema,
  type WorkspaceConfigState,
  type WorkspaceConfigTopicFrame,
  type WorkspaceConfigTopicWireCandidate,
  workspaceConfigTopic,
  workspaceConfigTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@zui/logger.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { createAckActivationBarrier } from "@zui/v4/ackActivationBarrier.js";
import { ensureAgentV4ConnectionHandshake } from "@zui/v4/agentV4ConnectionHandshake.js";
import { createTopicWireDecoder } from "@zui/v4/topicWireDecoder.js";

export type WorkspaceConfigAgentService = Pick<
  IZCodeAgentService,
  | "helloConversationV4"
  | "initializeConversationV4"
  | "subscribeWorkspaceConfigV4"
  | "resyncWorkspaceConfigV4"
  | "unsubscribeWorkspaceConfigV4"
  | "onDynamicWorkspaceConfigFrame"
  | "onAgentRuntimeRestarted"
> &
  Partial<Pick<IZCodeAgentService, "onAgentRuntimeLifecycle">>;
export interface WorkspaceConfigTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

class WorkspaceConfigSource {
  private readonly topic: string;
  private disposed = false;
  private started = false;
  private suspended = false;
  private generation = 0;
  private subscriptionId: string | null = null;
  private upstream: { dispose(): void } | null = null;
  private lifecycle: { dispose(): void } | null = null;
  private config: WorkspaceConfigState | null = null;
  private cursor: { logEpoch: string; seq: number } | null = null;
  private readySettled = false;
  private lastFailure: unknown = null;
  private recovery: {
    generation: number;
    subscriptionId: string;
    ack: boolean;
    frame: boolean;
  } | null = null;
  private resolveReady!: (value: WorkspaceConfigState) => void;
  private rejectReady!: (error: unknown) => void;
  private ready!: Promise<WorkspaceConfigState>;
  private readonly decoder: ReturnType<
    typeof createTopicWireDecoder<WorkspaceConfigTopicFrame>
  >;
  private readonly barrier: ReturnType<
    typeof createAckActivationBarrier<WorkspaceConfigTopicWireCandidate>
  >;

  constructor(
    private readonly agent: WorkspaceConfigAgentService,
    private readonly target: WorkspaceConfigTarget,
  ) {
    this.topic = workspaceConfigTopic(
      target.workspaceIdentity?.trim() || target.workspacePath,
    );
    this.resetReady();
    this.decoder = createTopicWireDecoder(
      new TopicWireFrameAssembler(workspaceConfigTopicFrameSchema),
      (frame, kind) => this.apply(frame, kind),
      (fault) => this.recover(fault),
    );
    this.barrier =
      createAckActivationBarrier<WorkspaceConfigTopicWireCandidate>((wire) =>
        this.decoder.accept(wire),
      );
  }

  private resetReady() {
    this.config = null;
    this.readySettled = false;
    this.lastFailure = null;
    this.ready = new Promise<WorkspaceConfigState>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // 背景lease也订阅；同一真实错误仍交给正在等待metadata prepare的调用方。
    void this.ready.catch(() => {
      /* background observer has no awaiting caller */
    });
  }

  private fail(error: unknown) {
    if (this.disposed) return;
    this.config = null;
    this.lastFailure = error;
    this.readySettled = true;
    useZCodeSessionStore
      .getState()
      .setConfigOptionsStatus(
        this.target.workspacePath,
        "error",
        this.target.workspaceIdentity,
      );
    this.rejectReady(error);
    logger.warn("工作区配置读取失败", {
      workspaceIdentity: this.target.workspaceIdentity,
      error,
    });
  }

  private apply(
    frame: WorkspaceConfigTopicFrame,
    deliveryKind: TopicFrameDeliveryKind,
  ) {
    if (
      this.disposed ||
      frame.subscriptionId !== this.subscriptionId ||
      frame.topic !== this.topic
    )
      return;
    let next: WorkspaceConfigState | undefined;
    if (frame.payload.kind === "snapshot") next = frame.payload.snapshot.config;
    else next = frame.payload.deltas.at(-1)?.config;
    if (!next) return;
    if (frame.payload.kind === "snapshot")
      this.cursor = {
        logEpoch: frame.payload.snapshot.logEpoch,
        seq: frame.toSeq,
      };
    else if (this.cursor) this.cursor.seq = frame.toSeq;
    this.config = next;
    const store = useZCodeSessionStore.getState();
    store.setConfigOptions(
      this.target.workspacePath,
      next.configOptions,
      this.target.workspaceIdentity,
    );
    store.setSlashCommands(
      this.target.workspacePath,
      next.slashCommands,
      this.target.workspaceIdentity,
    );
    store.setConfigOptionsStatus(
      this.target.workspacePath,
      "ready",
      this.target.workspaceIdentity,
    );
    this.readySettled = true;
    this.lastFailure = null;
    this.resolveReady(next);
    if (
      (deliveryKind === "recovery" ||
        (deliveryKind === "online" && frame.payload.kind === "snapshot")) &&
      this.recovery?.subscriptionId === frame.subscriptionId
    ) {
      // 配置是conflated整体态；新online snapshot会让producer丢弃较旧recovery。
      // 这份已验证的owned完整态可与原ACK收口，不能永远阻塞下一次same-sub恢复。
      this.recovery.frame = true;
      if (this.recovery.ack) this.recovery = null;
    }
  }

  private recover(fault: TopicWireAssemblyFault) {
    const id = this.subscriptionId;
    if (
      this.disposed ||
      this.suspended ||
      !id ||
      fault.topic !== this.topic ||
      fault.subscriptionId !== id
    )
      return;
    if (this.recovery) {
      if (fault.deliveryKind === "recovery") {
        this.recovery = null;
        this.fail(new Error(fault.reasonCode));
      }
      return;
    }
    const recovery = {
      generation: this.generation,
      subscriptionId: id,
      ack: false,
      frame: false,
    };
    this.recovery = recovery;
    if (this.readySettled) this.resetReady();
    else this.config = null;
    useZCodeSessionStore
      .getState()
      .setConfigOptionsStatus(
        this.target.workspacePath,
        "loading",
        this.target.workspaceIdentity,
      );
    this.decoder.recover(this.topic, id);
    void this.agent
      .resyncWorkspaceConfigV4({
        ...this.target,
        subscriptionId: id,
        base: this.cursor,
        forceSnapshot: true,
        runtimePolicy: "existing-only",
      })
      .then((value) => {
        if (
          this.disposed ||
          this.recovery !== recovery ||
          recovery.generation !== this.generation
        )
          return;
        const result = v4ConversationResyncResultSchema.parse(value);
        if (result.ack.subscriptionId !== id)
          throw new Error("配置恢复返回了不同的租约身份。");
        recovery.ack = true;
        if (recovery.frame) this.recovery = null;
      })
      .catch((error: unknown) => {
        if (
          this.recovery !== recovery ||
          recovery.generation !== this.generation
        )
          return;
        this.recovery = null;
        this.fail(error);
      });
  }

  private unsubscribe(id: string) {
    return this.agent
      .unsubscribeWorkspaceConfigV4({
        ...this.target,
        subscriptionId: id,
        runtimePolicy: "existing-only",
      })
      .catch((error: unknown) => logger.warn("工作区配置退订失败", { error }));
  }

  private async subscribe(generation: number) {
    const pending = this.barrier.begin(this.topic);
    try {
      await ensureAgentV4ConnectionHandshake(this.agent);
      if (this.disposed || generation !== this.generation) {
        this.barrier.cancel(pending);
        return;
      }
      const result = v4WorkspaceConfigSubscribeResultSchema.parse(
        await this.agent.subscribeWorkspaceConfigV4({
          ...this.target,
          runtimePolicy: "existing-only",
          visibility: "foreground",
        }),
      );
      if (this.disposed || generation !== this.generation) {
        this.barrier.cancel(pending);
        await this.unsubscribe(result.ack.subscriptionId);
        return;
      }
      this.barrier.bind(pending, result.ack.subscriptionId);
      this.subscriptionId = result.ack.subscriptionId;
      this.barrier.activate(this.subscriptionId);
    } catch (error) {
      this.barrier.cancel(pending);
      if (generation === this.generation) this.fail(error);
    }
  }

  activate() {
    if (this.disposed || this.suspended || this.started) return;
    this.started = true;
    // ACK前的initial可能在同一read内到达，必须在任何subscribe前同步安装listener。
    this.upstream ??= this.agent.onDynamicWorkspaceConfigFrame(this.target)(
      (wire) => this.barrier.accept(wire),
    );
    this.attachLifecycle();
    useZCodeSessionStore
      .getState()
      .setConfigOptionsStatus(
        this.target.workspacePath,
        "loading",
        this.target.workspaceIdentity,
      );
    void this.subscribe(this.generation);
  }

  private attachLifecycle() {
    if (this.lifecycle) return;
    const key =
      this.target.workspaceIdentity?.trim() || this.target.workspacePath;
    if (this.agent.onAgentRuntimeLifecycle) {
      this.lifecycle = this.agent.onAgentRuntimeLifecycle((event) => {
        if (event.workspaceKey !== key || this.disposed) return;
        this.invalidate();
        this.suspended = event.state === "unavailable";
        if (this.suspended) {
          this.fail(new Error("工作区配置连接暂不可用。"));
        } else {
          this.resetReady();
          this.activate();
        }
      });
      return;
    }
    this.lifecycle = this.agent.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== key || this.disposed) return;
      this.invalidate();
      this.resetReady();
      this.activate();
    });
  }

  private invalidate() {
    this.generation += 1;
    this.started = false;
    this.config = null;
    this.cursor = null;
    this.recovery = null;
    this.subscriptionId = null;
    this.barrier.clear();
    this.decoder.clear();
  }

  read() {
    if (this.disposed || this.suspended)
      return Promise.reject(new Error("工作区配置连接暂不可用。"));
    if (this.lastFailure !== null) {
      this.invalidate();
      this.resetReady();
    }
    this.activate();
    if (this.config) return Promise.resolve(this.config);
    return this.ready;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.upstream?.dispose();
    this.upstream = null;
    this.lifecycle?.dispose();
    this.lifecycle = null;
    this.barrier.clear();
    this.decoder.clear();
    this.rejectReady(new Error("配置连接租约已释放。"));
    if (this.subscriptionId) void this.unsubscribe(this.subscriptionId);
    this.subscriptionId = null;
  }
}

/** 每个现有Workspace connection entry持有一个只读配置订阅，不派生Task或执行权限。 */
export function createWorkspaceConfigConsumer(
  agent: WorkspaceConfigAgentService,
  target: WorkspaceConfigTarget,
) {
  return new WorkspaceConfigSource(agent, target);
}
export type WorkspaceConfigConsumer = ReturnType<
  typeof createWorkspaceConfigConsumer
>;
