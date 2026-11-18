import { createConnection, createServer, type Socket } from "node:net";

export interface CodeConnectionGate {
  readonly baseUrl: string;
  readonly blockedConnections: number;
  blockAndDisconnect(): void;
  release(): void;
  close(): Promise<void>;
}

/** 只转发独占回环服务的原始TCP字节，不生成或修改HTTP回复。 */
class LoopbackConnectionGate implements CodeConnectionGate {
  private readonly sockets = new Set<Socket>();
  private readonly held = new Set<Socket>();
  private readonly interrupted = new WeakSet<Socket>();
  private readonly closures: Promise<void>[] = [];
  private readonly failures: unknown[] = [];
  private blocked = false;
  private closed = false;
  private blockedCount = 0;
  private closing: Promise<void> | undefined;
  private readonly server = createServer((socket) => {
    this.track(socket);
    if (this.closed) {
      this.destroy(socket);
      return;
    }
    if (this.blocked) {
      this.held.add(socket);
      this.blockedCount++;
    } else this.forward(socket);
  });

  constructor(private readonly destination: URL) {
    this.server.on("error", (error) => this.failures.push(error));
  }

  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  get baseUrl() {
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("透明连接转发门尚未监听。");
    return `http://127.0.0.1:${address.port}`;
  }

  get blockedConnections() {
    return this.blockedCount;
  }

  private track(socket: Socket) {
    this.sockets.add(socket);
    socket.on("error", (error) => {
      if (!this.closed && !this.interrupted.has(socket))
        this.failures.push(error);
    });
    this.closures.push(
      new Promise<void>((resolve) => {
        socket.once("close", () => {
          this.sockets.delete(socket);
          this.held.delete(socket);
          resolve();
        });
      }),
    );
  }

  private destroy(socket: Socket) {
    this.interrupted.add(socket);
    socket.destroy();
  }

  private forward(frontend: Socket) {
    if (frontend.destroyed) return;
    const hostname = this.destination.hostname;
    const backend = createConnection({
      host:
        hostname === "localhost"
          ? "127.0.0.1"
          : hostname.replace(/^\[|\]$/gu, ""),
      port: Number(this.destination.port || "80"),
    });
    this.track(backend);
    frontend.once("close", () => this.destroy(backend));
    backend.once("close", () => this.destroy(frontend));
    frontend.pipe(backend);
    backend.pipe(frontend);
  }

  blockAndDisconnect() {
    if (this.closed || this.blocked)
      throw new Error("透明连接转发门当前不能再次阻断。");
    this.blocked = true;
    this.blockedCount = 0;
    for (const socket of this.sockets) this.destroy(socket);
  }

  release() {
    if (this.closed || !this.blocked)
      throw new Error("透明连接转发门当前没有等待放行的连接。");
    this.blocked = false;
    for (const socket of this.held) this.forward(socket);
    this.held.clear();
  }

  close() {
    this.closing ??= (async () => {
      this.closed = true;
      for (const socket of this.sockets) this.destroy(socket);
      await new Promise<void>((resolve) => {
        this.server.close((error) => {
          if (error) this.failures.push(error);
          resolve();
        });
      });
      await Promise.all(this.closures);
      if (this.failures.length)
        throw new AggregateError(this.failures, "透明连接转发或关闭失败。");
    })();
    return this.closing;
  }
}

export async function createCodeConnectionGate(
  upstreamBaseUrl: string,
): Promise<CodeConnectionGate> {
  const destination = new URL(upstreamBaseUrl);
  if (
    destination.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname) ||
    destination.username ||
    destination.password ||
    destination.pathname !== "/" ||
    destination.search ||
    destination.hash
  )
    throw new Error("透明连接转发门仅允许独占回环HTTP服务。");
  const gate = new LoopbackConnectionGate(destination);
  await gate.listen();
  return gate;
}
