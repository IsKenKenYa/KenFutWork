import { randomUUID } from "node:crypto";
import type { CodeUiEvent } from "@kenfutwork/shared";
import {
  type CodeUiWorkspace,
  codeUiControllerTaskListQuerySchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Emitter, type IChannel, ProxyChannel } from "@zcode/rpc";
import type { IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import { createWindowHostControllerRuntime } from "@zcode/window-controller";
import { CodeUiRepositoryError } from "./repository.js";

const requestSchemas = {
  listTaskList: codeUiControllerTaskListQuerySchema,
  subscribeControllerV4: protocol.controllerSubscribeParamsSchema,
  resyncControllerV4: protocol.controllerResyncParamsSchema,
  unsubscribeControllerV4: protocol.controllerUnsubscribeParamsSchema,
};

/** 只提供真实源与 RPC 载体；集合、overlay、delta、游标仍由固定原 Controller 决定。 */
export class CodeUiControllerHost {
  private readonly events = new Emitter<CodeUiEvent>();
  private readonly paths = new Map<string, CodeUiWorkspace>();
  private readonly runtime;
  private readonly subscription;
  private readonly channel;
  private readonly subscriptions = new Set<string>();
  private sending = Promise.resolve();
  private closed = false;

  constructor(
    private readonly deps: {
      workspaces: () => Promise<CodeUiWorkspace[]>;
      sourceCall: (
        service: string,
        method: string,
        args: unknown[],
      ) => Promise<unknown>;
      send: (event: CodeUiEvent) => Promise<void>;
      disposeSource: () => void;
      deliveryFailed: (error: unknown) => void;
    },
  ) {
    const taskService = ProxyChannel.toService<IZCodeTaskService>(
      this.sourceChannel("zcode-task"),
    );
    const agentService = ProxyChannel.toService<IZCodeAgentService>(
      this.sourceChannel("zcodeAgentService"),
    );
    this.runtime = createWindowHostControllerRuntime({
      createId: randomUUID,
      resolveSource: (scope) =>
        this.paths.has(scope.workspacePath) &&
        (!scope.workspaceIdentity ||
          scope.workspaceIdentity === scope.workspacePath)
          ? {
              scope: {
                kind: "local",
                workspacePath: scope.workspacePath,
                ...(scope.workspaceIdentity
                  ? { workspaceIdentity: scope.workspaceIdentity }
                  : {}),
              },
              taskService,
              agentService,
              sourceAvailability: "online",
            }
          : null,
    });
    this.channel = ProxyChannel.fromService(this.runtime.service);
    this.subscription = this.runtime.service.onDynamicControllerFrame()(
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

  accept(event: CodeUiEvent) {
    if (!this.closed) this.events.fire(event);
  }

  private sourceChannel(service: string): IChannel {
    return {
      call: <T>(method: string, args?: unknown) =>
        this.deps.sourceCall(
          service,
          method,
          (args as unknown[]) ?? [],
        ) as Promise<T>,
      listen:
        <T>(name: string, scope?: { workspacePath?: string }) =>
        (listener: (data: T) => void) =>
          this.events.event((event) => {
            if (
              scope?.workspacePath &&
              (!("workspacePath" in event) ||
                event.workspacePath !== scope.workspacePath)
            )
              return;
            if (
              event.event === "service" &&
              event.service === service &&
              event.name === name
            )
              listener(event.data as T);
            else if (
              service === "zcodeAgentService" &&
              event.event === name &&
              "frame" in event
            )
              listener(event.frame as T);
          }),
    };
  }

  private requireOpen() {
    if (this.closed)
      throw new CodeUiRepositoryError("not_found", "Controller 连接已关闭");
  }

  async call(method: string, value: unknown) {
    this.requireOpen();
    if (!Object.hasOwn(requestSchemas, method)) return null;
    const schema = requestSchemas[method as keyof typeof requestSchemas];
    if (!schema) return null;
    const input = schema.parse(value);
    if (method === "resyncControllerV4") {
      const params = protocol.controllerResyncParamsSchema.parse(input);
      if (!this.subscriptions.has(params.subscriptionId))
        throw new CodeUiRepositoryError(
          "not_found",
          "Controller 订阅不属于当前连接或已释放",
        );
    }
    const workspaces = await this.deps.workspaces();
    this.requireOpen();
    const next = new Map(
      workspaces.map((workspace) => [workspace.path, workspace]),
    );
    for (const path of this.paths.keys())
      if (!next.has(path))
        this.runtime.removeSource({ kind: "local", workspacePath: path });
    this.paths.clear();
    for (const [path, workspace] of next) this.paths.set(path, workspace);
    if (method === "listTaskList") {
      const query = codeUiControllerTaskListQuerySchema.parse(input);
      if (
        query.workspaceScopes.some(
          (scope) => !this.paths.has(scope.workspacePath),
        )
      )
        throw new CodeUiRepositoryError(
          "not_found",
          "Controller 工作目录不属于当前工作区或已归档",
        );
    }
    let result: unknown;
    try {
      result = await this.channel.call(undefined, method, [input]);
    } finally {
      // 原方法可跨异步源读取；连接关闭后清掉期间迟到创建的租约。
      if (this.closed) this.runtime.dispose();
    }
    this.requireOpen();
    if (method === "subscribeControllerV4")
      this.subscriptions.add(
        protocol.controllerSubscribeResultSchema.parse(result).ack
          .subscriptionId,
      );
    if (method === "unsubscribeControllerV4")
      this.subscriptions.delete(
        protocol.controllerUnsubscribeParamsSchema.parse(input).subscriptionId,
      );
    return { result };
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.subscription.dispose();
    this.runtime.dispose();
    this.events.dispose();
    this.subscriptions.clear();
    this.deps.disposeSource();
  }
}
