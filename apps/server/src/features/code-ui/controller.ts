import { randomUUID } from "node:crypto";
import {
  type CodeUiEvent,
  codeUiControllerTaskListQuerySchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Emitter, type IChannel, ProxyChannel } from "@zcode/rpc";
import type {
  IZCodeAgentService,
  IZCodeTaskService,
  ZCodeTaskListQuery,
} from "@zcode/services";
import { createWindowHostControllerRuntime } from "@zcode/window-controller";
import { CodeUiRepositoryError } from "./repository.js";

export interface CodeUiControllerSource {
  projectId: string;
  rootDirectory: string;
  /** 由当前可信 source 名单生成；调用方字符串不能授予任何执行权限。 */
  workspaceIdentity: string;
}
export interface CodeUiControllerHostDeps {
  sources(): Promise<
    readonly Pick<CodeUiControllerSource, "projectId" | "rootDirectory">[]
  >;
  sourceCall(
    source: CodeUiControllerSource,
    service: "zcode-task" | "zcodeAgentService",
    method: string,
    args: unknown[],
  ): Promise<unknown>;
  send(event: CodeUiEvent): Promise<void>;
  disposeSource(source?: CodeUiControllerSource): Promise<void>;
  deliveryFailed(error: unknown): void;
}
interface ResolvedSource {
  source: CodeUiControllerSource;
  taskService: IZCodeTaskService;
  agentService: IZCodeAgentService;
}
const agentReadMethods = new Set([
  "subscribeSessionsIndexV4",
  "resyncSessionsIndexV4",
  "unsubscribeSessionsIndexV4",
]);
const taskReadMethods = new Set([
  "listTasks",
  "listPinnedTasks",
  "listArchivedTasks",
  "listTaskList",
]);

/** 固定原 Controller 持有投影/成员/排序；宿主仅适配可信 Project 与 Task 固定目录。 */
export class CodeUiControllerHost {
  private readonly events = new Emitter<CodeUiEvent>();
  private readonly sources = new Map<string, ResolvedSource>();
  private readonly runtime;
  private readonly frameSubscription;
  private sending = Promise.resolve();
  private closed = false;
  private readonly calls = new Set<Promise<unknown>>();
  private readonly subscriptions = new Set<string>();
  private readonly sourceOperations = new Map<string, Set<Promise<unknown>>>();
  private closing: Promise<void> | undefined;
  private queue = Promise.resolve();
  private reading: { identities: Set<string>; errors: unknown[] } | undefined;

  constructor(private readonly deps: CodeUiControllerHostDeps) {
    this.runtime = createWindowHostControllerRuntime({
      createId: randomUUID,
      onSourceError: (scope, _operation, error) => {
        const identity = scope.workspaceIdentity ?? scope.workspacePath;
        if (this.reading?.identities.has(identity))
          this.reading.errors.push(error);
      },
      resolveSource: (scope) => {
        const resolved = this.resolveSource(scope);
        return resolved
          ? {
              scope: {
                kind: "local",
                workspacePath: resolved.source.rootDirectory,
                workspaceIdentity: resolved.source.workspaceIdentity,
              },
              taskService: resolved.taskService,
              agentService: resolved.agentService,
              sourceAvailability: "online",
            }
          : null;
      },
    });
    this.frameSubscription = this.runtime.service.onDynamicControllerFrame()(
      (data) => {
        this.sending = this.sending
          .then(async () => {
            if (!this.closed)
              await this.deps.send({
                event: "service",
                service: "window-controller",
                name: "onDynamicControllerFrame",
                data,
              });
          })
          .catch((error: unknown) => this.deps.deliveryFailed(error));
      },
    );
  }

  accept(event: CodeUiEvent): void {
    if (!this.closed) this.events.fire(event);
  }

  private requireOpen(): void {
    if (this.closed)
      throw new CodeUiRepositoryError("not_found", "Controller 连接已关闭");
  }

  private resolveSource(scope: {
    workspacePath: string;
    workspaceIdentity?: string | undefined;
  }): ResolvedSource | null {
    const identity = scope.workspaceIdentity?.trim();
    const matches = [...this.sources.values()].filter(
      ({ source }) =>
        source.rootDirectory === scope.workspacePath &&
        (!identity ||
          identity === source.workspaceIdentity ||
          identity === source.projectId),
    );
    if (matches.length > 1)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "多个 Code 项目共享此目录，请明确提供项目身份。",
      );
    return matches[0] ?? null;
  }

  private matchesTaskEvent(
    data: unknown,
    source: CodeUiControllerSource,
  ): boolean {
    if (!data || typeof data !== "object") return false;
    const event = data as {
      workspaceIdentity?: unknown;
      taskMeta?: { projectId?: unknown; workspacePath?: unknown };
    };
    return (
      event.workspaceIdentity === source.workspaceIdentity &&
      (!event.taskMeta ||
        (event.taskMeta.projectId === source.projectId &&
          event.taskMeta.workspacePath === source.rootDirectory))
    );
  }

  private sourceChannel(
    source: CodeUiControllerSource,
    service: "zcode-task" | "zcodeAgentService",
  ): IChannel {
    return {
      call: <T>(method: string, value?: unknown) => {
        if (this.closed && method !== "unsubscribeSessionsIndexV4")
          this.requireOpen();
        const allowed =
          service === "zcode-task" ? taskReadMethods : agentReadMethods;
        if (!allowed.has(method))
          throw new CodeUiRepositoryError(
            "not_found",
            "Controller source 只允许读取索引和现存 sessions 订阅。",
          );
        const args = (value as unknown[]) ?? [];
        const parameters =
          service === "zcodeAgentService"
            ? [
                { ...(args[0] as object), runtimePolicy: "existing-only" },
                ...args.slice(1),
              ]
            : args;
        return this.callSource(
          source,
          service,
          method,
          parameters,
        ) as Promise<T>;
      },
      listen:
        <T>(name: string) =>
        (listener: (data: T) => void) =>
          this.events.event((event) => {
            if (
              event.event === "service" &&
              event.service === service &&
              event.name === name
            ) {
              if (
                service === "zcode-task" &&
                (event.workspacePath !== source.rootDirectory ||
                  !this.matchesTaskEvent(event.data, source))
              )
                return;
              listener(event.data as T);
            } else if (
              service === "zcodeAgentService" &&
              event.event === name &&
              "frame" in event &&
              event.workspacePath === source.rootDirectory
            )
              listener(event.frame as T);
          }),
    };
  }

  private callSource(
    source: CodeUiControllerSource,
    service: "zcode-task" | "zcodeAgentService",
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const operations =
      this.sourceOperations.get(source.workspaceIdentity) ??
      new Set<Promise<unknown>>();
    this.sourceOperations.set(source.workspaceIdentity, operations);
    const pending: Promise<unknown> = Promise.resolve()
      .then(() => this.deps.sourceCall(source, service, method, args))
      .finally(() => {
        operations.delete(pending);
        if (
          !operations.size &&
          this.sourceOperations.get(source.workspaceIdentity) === operations
        )
          this.sourceOperations.delete(source.workspaceIdentity);
      });
    operations.add(pending);
    return pending;
  }

  private async drainSourceOperations(identity?: string): Promise<void> {
    while (true) {
      const pending = identity
        ? [...(this.sourceOperations.get(identity) ?? [])]
        : [...this.sourceOperations.values()].flatMap((operations) => [
            ...operations,
          ]);
      if (!pending.length) return;
      // ACK后的原observer可以产生迟到unsubscribe；每轮重新收集直到租约操作全部settled。
      await Promise.allSettled(pending);
    }
  }

  private async synchronizeSources(): Promise<void> {
    const available = await this.deps.sources();
    this.requireOpen();
    const next = new Map<string, ResolvedSource>();
    for (const candidate of available) {
      const workspaceIdentity = JSON.stringify([
        candidate.projectId,
        candidate.rootDirectory,
      ]);
      const source = { ...candidate, workspaceIdentity };
      next.set(
        workspaceIdentity,
        this.sources.get(workspaceIdentity) ?? {
          source,
          taskService: ProxyChannel.toService<IZCodeTaskService>(
            this.sourceChannel(source, "zcode-task"),
          ),
          agentService: ProxyChannel.toService<IZCodeAgentService>(
            this.sourceChannel(source, "zcodeAgentService"),
          ),
        },
      );
    }
    for (const [identity, previous] of this.sources) {
      if (next.has(identity)) continue;
      this.runtime.removeSource({
        kind: "local",
        workspacePath: previous.source.rootDirectory,
        workspaceIdentity: identity,
      });
      await this.drainSourceOperations(identity);
      await this.deps.disposeSource(previous.source);
    }
    this.sources.clear();
    for (const [identity, source] of next) this.sources.set(identity, source);
  }

  private async readIndex(query: ZCodeTaskListQuery) {
    const reading = {
      identities: new Set(
        query.workspaceScopes.map(
          (scope) => scope.workspaceIdentity ?? scope.workspacePath,
        ),
      ),
      errors: [] as unknown[],
    };
    this.reading = reading;
    try {
      const result = await this.runtime.service.listTaskList(query);
      this.requireOpen();
      if (reading.errors.length) throw reading.errors[0];
      return result;
    } finally {
      this.reading = undefined;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending: Promise<T> = this.queue
      .then(() => {
        this.requireOpen();
        return operation();
      })
      .finally(() => this.calls.delete(pending));
    this.calls.add(pending);
    this.queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }

  call(method: string, value: unknown): Promise<{ result: unknown } | null> {
    return this.enqueue(() => this.callOpen(method, value));
  }

  refresh(): Promise<void> {
    return this.enqueue(async () => {
      await this.synchronizeSources();
      this.requireOpen();
      // 原核以Task服务代理代次区分索引快照；显式失效只轮换只读代理，不伪造离线。
      for (const resolved of this.sources.values())
        resolved.taskService = ProxyChannel.toService<IZCodeTaskService>(
          this.sourceChannel(resolved.source, "zcode-task"),
        );
      await this.readIndex({
        kind: "active",
        sortBy: "updated",
        workspaceScopes: [...this.sources.values()].map(({ source }) => ({
          workspacePath: source.rootDirectory,
          workspaceIdentity: source.workspaceIdentity,
        })),
      });
      this.requireOpen();
      await this.sending;
    });
  }

  private async callOpen(
    method: string,
    value: unknown,
  ): Promise<{ result: unknown } | null> {
    this.requireOpen();
    if (method === "resyncControllerV4") {
      const params = protocol.controllerResyncParamsSchema.parse(value);
      if (!this.subscriptions.has(params.subscriptionId))
        throw new CodeUiRepositoryError(
          "not_found",
          "Controller 订阅不属于当前连接或已释放。",
        );
      return { result: await this.runtime.service.resyncControllerV4(params) };
    }
    if (method === "unsubscribeControllerV4") {
      const params = protocol.controllerUnsubscribeParamsSchema.parse(value);
      if (!this.subscriptions.has(params.subscriptionId))
        throw new CodeUiRepositoryError(
          "not_found",
          "Controller 订阅不属于当前连接或已释放。",
        );
      await this.runtime.service.unsubscribeControllerV4(params);
      this.subscriptions.delete(params.subscriptionId);
      return { result: null };
    }
    if (method === "subscribeControllerV4") {
      const params = protocol.controllerSubscribeParamsSchema.parse(value);
      await this.synchronizeSources();
      this.requireOpen();
      const result = await this.runtime.service.subscribeControllerV4(params);
      if (this.closed) this.runtime.dispose();
      this.requireOpen();
      this.subscriptions.add(result.ack.subscriptionId);
      return { result };
    }
    if (method !== "listTaskList") return null;
    const query = codeUiControllerTaskListQuerySchema.parse(value);
    await this.synchronizeSources();
    const workspaceScopes = query.workspaceScopes.map((scope) => {
      const resolved = this.resolveSource(scope);
      if (!resolved)
        throw new CodeUiRepositoryError(
          "not_found",
          "Controller 工作目录不属于当前工作区或已归档。",
        );
      return {
        workspacePath: resolved.source.rootDirectory,
        workspaceIdentity: resolved.source.workspaceIdentity,
      };
    });
    const result = await this.readIndex({
      kind: query.kind,
      sortBy: query.sortBy,
      workspaceScopes,
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    this.requireOpen();
    return { result };
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.frameSubscription.dispose();
    this.runtime.dispose();
    this.events.dispose();
    this.sources.clear();
    this.subscriptions.clear();
    this.closing = (async () => {
      while (this.calls.size) await Promise.allSettled([...this.calls]);
      await this.drainSourceOperations();
      await this.sending;
      await this.deps.disposeSource();
    })();
    return this.closing;
  }
}
