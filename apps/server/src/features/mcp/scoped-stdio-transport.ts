import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ManagedStdioProcess,
  ProcessSandbox,
  ProcessStdioSpawnRequest,
} from "../process-sandbox/types.js";
import { ProcessSandboxError } from "../process-sandbox/types.js";

export interface ScopedMcpTransport extends Transport {
  stop(reason: string): Promise<void>;
}

type Options = {
  sandbox: Pick<ProcessSandbox, "spawnStdio">;
  request: ProcessStdioSpawnRequest;
  maxMessageBytes: number;
};

class ProcessStdioTransport implements ScopedMcpTransport {
  declare onclose?: () => void;
  declare onerror?: NonNullable<Transport["onerror"]>;
  declare onmessage?: NonNullable<Transport["onmessage"]>;
  private readonly reader: ReadBuffer;
  private child: ManagedStdioProcess | undefined;
  private started: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private stoppingChild: Promise<void> | undefined;
  private closing = false;
  private closed = false;
  private reason = "MCP连接已关闭";
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly options: Options) {
    this.reader = new ReadBuffer({ maxBufferSize: options.maxMessageBytes });
  }

  private notifyClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.reader.clear();
    this.onclose?.();
  }

  private report(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    const message = Object.values(this.options.request.env ?? {})
      .filter(Boolean)
      .reduce((value, secret) => value.split(secret).join("[已隐藏]"), text);
    this.onerror?.(new Error(message));
  }

  private stopChild(): Promise<void> {
    if (this.stoppingChild) return this.stoppingChild;
    this.stoppingChild = (async () => {
      if (!this.child) return;
      const exit = await this.child.stop(this.reason);
      if (!exit.rangeEmpty)
        throw new ProcessSandboxError(
          "stop_unconfirmed",
          "MCP进程范围尚未确认清空，不能报告连接已关闭。",
        );
      this.notifyClosed();
    })().catch((error) => {
      this.stoppingChild = undefined;
      throw error;
    });
    return this.stoppingChild;
  }

  private receive(data: string): void {
    if (this.closing) return;
    try {
      this.reader.append(Buffer.from(data));
      for (
        let message = this.reader.readMessage();
        message;
        message = this.reader.readMessage()
      )
        this.onmessage?.(message);
    } catch (error) {
      this.report(error);
      // 当前stdout回调先返回让Provider ACK，stop随后等待真实范围退出，避免自等delivery。
      void this.stop("MCP stdio消息无效或超出预算").catch((failure) =>
        this.report(failure),
      );
    }
  }

  start(): Promise<void> {
    if (this.started || this.closing)
      return Promise.reject(new Error("MCP传输已启动或关闭。"));
    this.started = (async () => {
      const child = await this.options.sandbox.spawnStdio(this.options.request);
      this.child = child;
      const fact = child.snapshot();
      const request = this.options.request;
      if (
        fact.ownerTaskId !== request.scope.taskId ||
        fact.generation !== request.scope.generation ||
        fact.agentId !== request.agentId ||
        fact.invocationId !== request.invocationId
      ) {
        this.closing = true;
        this.reason = "MCP进程Task身份不匹配";
        await this.stopChild();
        throw new Error(this.reason);
      }
      this.unsubscribers.push(
        child.onStdout((data) => this.receive(data)),
        child.onStderr(() => {}),
      );
      void child
        .waitForExit()
        .then((exit) => {
          if (!exit.rangeEmpty)
            throw new ProcessSandboxError(
              "stop_unconfirmed",
              "MCP进程退出未确认范围清空。",
            );
          this.notifyClosed();
        })
        .catch((error) => this.report(error));
      if (this.closing) {
        await this.stopChild();
        throw new Error("MCP启动期间Task已关闭。");
      }
    })();
    return this.started;
  }

  async send(message: Parameters<Transport["send"]>[0]): Promise<void> {
    if (this.closing || !this.child)
      throw new Error("MCP连接已关闭或尚未启动。");
    const data = serializeMessage(message);
    if (Buffer.byteLength(data) > this.options.maxMessageBytes)
      throw new Error("MCP请求超过工作区进程输出预算。");
    await this.child.writeStdin(data);
  }

  close(): Promise<void> {
    return this.stop("MCP连接已关闭");
  }

  stop(reason: string): Promise<void> {
    this.closing = true;
    this.reason = reason;
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      try {
        await this.started;
      } catch {
        /* 失败启动仍需清理由Provider返回的句柄。 */
      }
      if (this.child) await this.stopChild();
      else this.notifyClosed();
    })().catch((error) => {
      this.stopping = undefined;
      throw error;
    });
    return this.stopping;
  }
}

export function createScopedMcpTransport(options: Options): ScopedMcpTransport {
  return new ProcessStdioTransport(options);
}
