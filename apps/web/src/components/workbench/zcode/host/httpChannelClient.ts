import {
  AGENT_GOVERNANCE_DEFAULTS,
  clampCodeUiReconnectDelayMs,
} from "@kenfutwork/shared";
import {
  Emitter,
  type Event,
  type IChannel,
  type IChannelClient,
} from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  type ClientHello,
  clientHelloSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { RemoteServiceAccess } from "./upstream/remoteServiceAccess.js";

export interface CodeHostConfig {
  apiBase: string;
  accessToken?: string;
  workspacePath?: string;
}
interface Notification {
  event: string;
  service?: string;
  name?: string;
  workspacePath?: string;
  data?: unknown;
  frame?: unknown;
  hello?: { connectionId: string };
  reconnectDelayMs?: number;
}

function notificationReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  return async (): Promise<Notification> => {
    for (;;) {
      const boundary = /\r?\n\r?\n/u.exec(buffer);
      if (!boundary) {
        const part = await reader.read();
        if (part.done) throw new Error("Code 通知通道已关闭");
        buffer += decoder.decode(part.value, { stream: true });
        continue;
      }
      const record = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = record
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) return JSON.parse(data) as Notification;
    }
  };
}

class NotificationConnectionError extends Error {
  constructor(readonly status: number) {
    super(`Code 通知通道不可用：${status}`);
  }
}

const servicesByChannel: Record<string, string> = {
  [ServiceChannels.ZCodeAgent]: "zcodeAgentService",
  [ServiceChannels.ModelSelection]: "modelSelectionService",
  [ServiceChannels.ProviderSettings]: "providerSettingsService",
};

/** ChannelClient 只替换载体；原 RemoteServiceAccess/ProxyChannel 保留服务和事件语义。 */
export class CodeHttpChannelClient implements IChannelClient {
  readonly services = new RemoteServiceAccess(this);
  private readonly notifications = new Emitter<Notification>();
  private readonly controller = new AbortController();
  private connectionId = "";
  private connected = false;
  private generation = 0;
  private clientHello: ClientHello | null = null;
  private reconnectDelayMs: number =
    AGENT_GOVERNANCE_DEFAULTS.codeUiReconnectDelayMs;
  private readonly workspaces = new Map<
    string,
    { path: string; references: number }
  >();
  private ready: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: unknown) => void;
  } | null = null;
  private running: Promise<void> | null = null;
  private fatalError: unknown;

  constructor(readonly config: CodeHostConfig) {}

  private headers(): Record<string, string> {
    return this.config.accessToken
      ? { authorization: `Bearer ${this.config.accessToken}` }
      : {};
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(
      `${this.config.apiBase.replace(/\/$/u, "")}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        credentials: "omit",
        signal: this.controller.signal,
        headers: {
          ...this.headers(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error?.message ?? `Code 宿主请求失败：${response.status}`,
      );
    return result as T;
  }

  connect(): Promise<void> {
    if (this.controller.signal.aborted)
      return Promise.reject(new DOMException("Code 宿主已关闭", "AbortError"));
    if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
    if (this.connected) return Promise.resolve();
    const ready = this.prepareReady();
    this.running ??= this.consumeConnections().catch((error: unknown) => {
      this.fatalError = error;
      this.ready?.reject(error);
      this.ready = null;
    });
    return ready.promise;
  }

  private prepareReady() {
    if (!this.ready) {
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void promise.catch(() => {});
      this.ready = { promise, resolve, reject };
    }
    return this.ready;
  }

  private async openNotifications() {
    const response = await fetch(
      `${this.config.apiBase.replace(/\/$/u, "")}/api/code-ui/events`,
      {
        headers: this.headers(),
        credentials: "omit",
        signal: this.controller.signal,
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new NotificationConnectionError(response.status);
    }
    const reader = response.body.getReader();
    return { reader, read: notificationReader(reader) };
  }

  private async consumeConnections() {
    while (!this.controller.signal.aborted) {
      let stream:
        | Awaited<ReturnType<CodeHttpChannelClient["openNotifications"]>>
        | undefined;
      try {
        stream = await this.openNotifications();
        const initial = await stream.read();
        if (initial.event !== "ready" || !initial.hello?.connectionId)
          throw new Error("Code 宿主缺少原协议 hello");
        this.connectionId = initial.hello.connectionId;
        if (initial.reconnectDelayMs !== undefined)
          this.reconnectDelayMs = clampCodeUiReconnectDelayMs(
            initial.reconnectDelayMs,
          );
        const restoring = this.generation > 0;
        this.generation += 1;
        if (restoring) await this.restoreServices();
        this.connected = true;
        this.ready?.resolve();
        this.ready = null;
        if (restoring) {
          for (const key of this.workspaces.keys())
            this.notifications.fire({
              event: "service",
              service: "zcodeAgentService",
              name: "onAgentRuntimeRestarted",
              data: { workspaceKey: key },
            });
          this.publishLifecycle("available");
        }
        while (!this.controller.signal.aborted)
          this.notifications.fire(await stream.read());
      } catch (error) {
        if (this.controller.signal.aborted) return;
        if (this.connected) {
          this.connected = false;
          this.prepareReady();
          this.publishLifecycle("unavailable");
        }
        this.connectionId = "";
        if (
          error instanceof NotificationConnectionError &&
          (error.status === 401 || error.status === 403)
        )
          throw error;
        await this.waitToReconnect();
      } finally {
        if (stream) {
          await stream.reader.cancel().catch(() => {});
          stream.reader.releaseLock();
        }
      }
    }
  }

  private async restoreServices() {
    if (this.clientHello)
      await this.request("/api/code-ui/rpc", {
        connectionId: this.connectionId,
        service: "zcodeAgentService",
        method: "initializeConversationV4",
        args: [this.clientHello],
      });
    for (const service of [
      "providerSettingsService",
      "modelSelectionService",
    ]) {
      const view = await this.request<{ result: unknown }>("/api/code-ui/rpc", {
        connectionId: this.connectionId,
        service,
        method: "getView",
        args: [],
      });
      this.notifications.fire({
        event: "service",
        service,
        name: "onDidChange",
        data: view.result,
      });
    }
  }

  private publishLifecycle(state: "available" | "unavailable") {
    for (const [workspaceKey, { path }] of this.workspaces)
      this.notifications.fire({
        event: "service",
        service: "zcodeAgentService",
        name: "onAgentRuntimeLifecycle",
        data: {
          workspaceKey,
          workspacePath: path,
          state,
          runtimeIdentity: {
            workspaceKey,
            generation: this.generation,
            identity: this.connectionId,
          },
        },
      });
  }

  private waitToReconnect() {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, this.reconnectDelayMs);
      this.controller.signal.addEventListener("abort", finish, { once: true });
      if (this.controller.signal.aborted) finish();
    });
  }

  getChannel<T extends IChannel>(channelName: string): T {
    const service = servicesByChannel[channelName] ?? channelName;
    const channel: IChannel = {
      call: async <T>(method: string, args?: unknown) => {
        await this.connect();
        if (
          service === "zcodeAgentService" &&
          method === "initializeConversationV4"
        )
          this.clientHello = clientHelloSchema.parse((args as unknown[])[0]);
        const response = await this.request<{ result: T }>("/api/code-ui/rpc", {
          ...(this.connectionId ? { connectionId: this.connectionId } : {}),
          service,
          method,
          args: args ?? [],
        });
        return response.result;
      },
      listen:
        <T>(event: string, scope?: { workspacePath?: string }): Event<T> =>
        (listener) => {
          if (scope?.workspacePath) {
            const target = this.workspaces.get(scope.workspacePath) ?? {
              path: scope.workspacePath,
              references: 0,
            };
            target.references += 1;
            this.workspaces.set(scope.workspacePath, target);
          }
          const eventSubscription = this.notifications.event((notification) => {
            if (
              scope?.workspacePath &&
              scope.workspacePath !== notification.workspacePath
            )
              return;
            if (notification.event === "service") {
              if (
                notification.service === service &&
                notification.name === event
              )
                listener(notification.data as T);
            } else if (notification.event === event)
              listener(notification.frame as T);
          });
          return {
            dispose: () => {
              eventSubscription.dispose();
              if (scope?.workspacePath) {
                const target = this.workspaces.get(scope.workspacePath);
                if (target && --target.references === 0)
                  this.workspaces.delete(scope.workspacePath);
              }
            },
          };
        },
    };
    return channel as T;
  }

  dispose() {
    this.controller.abort();
    this.connected = false;
    this.ready?.reject(new DOMException("Code 宿主已关闭", "AbortError"));
    this.ready = null;
    this.notifications.dispose();
  }
}
