import { Emitter, type Event, type IChannel, type IChannelClient } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { RemoteServiceAccess } from "./upstream/remoteServiceAccess.js";

export interface CodeHostConfig {
  apiBase: string;
  accessToken?: string;
  workspacePath?: string;
}
interface Notification { event: string; service?: string; name?: string; workspacePath?: string; data?: unknown; frame?: unknown; hello?: { connectionId: string }; }

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

  constructor(readonly config: CodeHostConfig) {}

  private headers() { return this.config.accessToken ? { authorization: `Bearer ${this.config.accessToken}` } : {}; }

  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.config.apiBase.replace(/\/$/u, "")}${path}`, {
      method: body === undefined ? "GET" : "POST", credentials: "omit",
      headers: { ...this.headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? `Code 宿主请求失败：${response.status}`);
    return result as T;
  }

  async connect(): Promise<void> {
    const response = await fetch(`${this.config.apiBase.replace(/\/$/u, "")}/api/code-ui/events`, { headers: this.headers(), credentials: "omit", signal: this.controller.signal });
    if (!response.ok || !response.body) throw new Error(`Code 通知通道不可用：${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const read = async () => {
      while (!buffer.includes("\n\n")) {
        const part = await reader.read();
        if (part.done) throw new Error("Code 通知通道已关闭");
        buffer += decoder.decode(part.value, { stream: true });
      }
      const end = buffer.indexOf("\n\n");
      const record = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return JSON.parse(record.slice("data: ".length)) as Notification;
    };
    const initial = await read();
    if (initial.event !== "ready" || !initial.hello?.connectionId) throw new Error("Code 宿主缺少原协议 hello");
    this.connectionId = initial.hello.connectionId;
    void (async () => {
      while (!this.controller.signal.aborted) this.notifications.fire(await read());
    })().catch((error: unknown) => {
      if (!this.controller.signal.aborted) console.error("Code 通知连接失败", error);
    });
  }

  getChannel<T extends IChannel>(channelName: string): T {
    const service = servicesByChannel[channelName] ?? channelName;
    const channel: IChannel = {
      call: async <T>(method: string, args?: unknown) => {
        const response = await this.request<{ result: T }>("/api/code-ui/rpc", { connectionId: this.connectionId, service, method, args: args ?? [] });
        return response.result;
      },
      listen: <T>(event: string, scope?: { workspacePath?: string }): Event<T> => (listener) => this.notifications.event((notification) => {
        if (scope?.workspacePath && scope.workspacePath !== notification.workspacePath) return;
        if (notification.event === "service") {
          if (notification.service === service && notification.name === event) listener(notification.data as T);
        } else if (notification.event === event) listener(notification.frame as T);
      }),
    };
    return channel as T;
  }

  dispose() { this.controller.abort(); this.notifications.dispose(); }
}
