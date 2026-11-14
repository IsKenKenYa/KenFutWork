import { createConnection, type Socket } from "node:net";

export class HelperRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly actionSent?: boolean,
  ) {
    super(message);
    this.name = "HelperRpcError";
  }
}

export interface HelperClientOptions {
  socketPath: string;
  token: string;
  timeoutMs?: number;
  clientVersion?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface HelperResponse {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    actionSent?: unknown;
  };
}

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class HelperClient {
  private readonly socket: Socket;
  private readonly timeoutMs: number;
  private buffer = "";
  private nextId = 0;
  private closed = false;
  private pending = new Map<string, PendingRequest>();
  readonly helper: Record<string, unknown>;

  get socketDestroyed(): boolean {
    return this.closed || this.socket.destroyed;
  }

  private constructor(
    socket: Socket,
    timeoutMs: number,
    helper: Record<string, unknown>,
  ) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.helper = helper;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", () =>
      this.fail(new HelperRpcError("disconnected", "Helper 连接已断开。")),
    );
    socket.on("close", () =>
      this.fail(new HelperRpcError("disconnected", "Helper 连接已关闭。")),
    );
  }

  static async connect(options: HelperClientOptions): Promise<HelperClient> {
    if (!/^[a-f0-9]{64}$/u.test(options.token))
      throw new HelperRpcError("invalid_argument", "Helper token 格式无效。");
    const timeoutMs = options.timeoutMs ?? 10_000;
    const socket = createConnection({ path: options.socketPath });
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new HelperRpcError("connect_failed", "Helper socket 连接超时。"),
        );
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(
          new HelperRpcError(
            "connect_failed",
            `无法连接 Helper socket：${error.message}`,
          ),
        );
      });
    });
    await connected;
    const client = new HelperClient(socket, timeoutMs, {});
    try {
      const hello = await client.request<Record<string, unknown>>("hello", {
        protocolVersion: 1,
        client: "kenfutwork-server",
        clientVersion: options.clientVersion ?? "0.1.0",
        token: options.token,
      });
      const helper = hello;
      if (typeof helper.bundleId !== "string")
        throw new HelperRpcError(
          "protocol_error",
          "Helper hello 缺少 bundleId。",
        );
      Object.assign(client.helper, helper);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = this.timeoutMs,
  ): Promise<T> {
    if (this.closed || this.socket.destroyed)
      throw new HelperRpcError("disconnected", "Helper 连接已关闭。");
    const id = String(++this.nextId);
    const payload = { id, method, ...(params ? { params } : {}) };
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperRpcError("timeout", `Helper 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          new HelperRpcError(
            "disconnected",
            `Helper 写入失败：${error.message}`,
          ),
        );
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.fail(new HelperRpcError("disconnected", "Helper 连接已关闭。"));
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.fail(new HelperRpcError("protocol_error", "Helper 响应超过上限。"));
      this.close();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let response: HelperResponse;
    try {
      response = JSON.parse(line) as HelperResponse;
    } catch {
      this.fail(
        new HelperRpcError("protocol_error", "Helper 返回了无效 JSON。"),
      );
      return;
    }
    if (typeof response.id !== "string") {
      this.fail(new HelperRpcError("protocol_error", "Helper 响应缺少 id。"));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok === true) {
      pending.resolve(response.result);
      return;
    }
    const error = response.error;
    pending.reject(
      new HelperRpcError(
        typeof error?.code === "string" ? error.code : "helper_error",
        typeof error?.message === "string"
          ? error.message
          : "Helper 请求失败。",
        typeof error?.actionSent === "boolean" ? error.actionSent : undefined,
      ),
    );
  }

  private fail(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
