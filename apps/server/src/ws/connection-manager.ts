import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import type { WebSocket } from "ws";

type PendingRPC = {
  /**
   * RPC 返回值经 JSON 往返只剩 unknown，故存储侧按 unknown 收下（方法签名而非函数属性，
   * 使 Promise<T> 的 resolver 能直接存入）；类型收窄由 `rpc<T>` 的调用方声明负责。
   */
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export type ConnectionEntry = {
  ws: WebSocket;
  instanceId: string;
  accessClientId: string | null;
  connectionId: string;
  canvasId: string | null;
};

export class ConnectionIdentityConflictError extends Error {
  constructor() {
    super("连接标识已属于另一个本机接入客户端，不能接管。");
    this.name = "ConnectionIdentityConflictError";
  }
}

export class ConnectionManager {
  /** Primary store: connectionId -> entry */
  private connections = new Map<string, ConnectionEntry>();
  /** User-level index: instanceId -> set of connectionIds */
  private instanceIndex = new Map<string, Set<string>>();
  /** Canvas-level index: canvasId -> set of connectionIds */
  private canvasIndex = new Map<string, Set<string>>();
  /** Tracks active runIds per canvas so reconnecting clients know if a run is in progress */
  private activeRuns = new Map<string, { runId: string; startedAt: number }>();
  /** Pending RPC calls, keyed by unique request UUID (unchanged) */
  private pendingRPCs = new Map<string, PendingRPC>();

  // ---------------------------------------------------------------------------
  // Registration & removal
  // ---------------------------------------------------------------------------

  /**
   * Register a connection. Multiple connections per user are allowed.
   * If the same connectionId already exists (reconnect), replace only that entry
   * without closing any other connections.
   */
  register(
    connectionId: string,
    instanceId: string,
    ws: WebSocket,
    accessClientId: string | null = null,
  ): void {
    const existing = this.connections.get(connectionId);
    if (existing) {
      if (
        existing.instanceId !== instanceId ||
        existing.accessClientId !== accessClientId
      ) {
        throw new ConnectionIdentityConflictError();
      }
      // Reconnect for same connectionId: clean up old entry from indexes
      this.removeFromIndexes(connectionId, existing);
    }

    const entry: ConnectionEntry = {
      ws,
      instanceId,
      accessClientId,
      connectionId,
      canvasId: null,
    };
    this.connections.set(connectionId, entry);

    let userSet = this.instanceIndex.get(instanceId);
    if (!userSet) {
      userSet = new Set();
      this.instanceIndex.set(instanceId, userSet);
    }
    userSet.add(connectionId);
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(4000, "同一本机客户端已重新连接");
      } catch {
        // 新entry已就位，旧socket关闭失败不能破坏新注册。
        console.warn("旧WebSocket重连资源关闭失败，新的连接注册已保留。");
        try {
          existing.ws.terminate();
        } catch {
          console.warn("旧WebSocket强制关闭尚未确认。");
        }
      }
    }
  }

  /**
   * Remove a connection from all indexes.
   *
   * `socket` 是身份校验用：connectionId 由客户端提供且**重连时复用**（handler.ts 查询参数），
   * 新 socket 注册同一 id 后，旧 socket 迟到的 close/error 事件不能把新注册误删——
   * 否则连接活着但 map entry 没了，run 事件全部 `delivered=false`（消息进得来、推送出不去）。
   */
  remove(connectionId: string, socket?: WebSocket): void {
    const entry = this.connections.get(connectionId);
    if (!entry) return;
    if (socket && entry.ws !== socket) return;
    this.removeFromIndexes(connectionId, entry);
    this.connections.delete(connectionId);
  }

  /**
   * Associate a connection with a canvas.
   * Updates the canvasIndex so events can be broadcast to all viewers of that canvas.
   */
  bindCanvas(connectionId: string, canvasId: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry) return;

    // Remove from previous canvas index if switching canvases
    if (entry.canvasId && entry.canvasId !== canvasId) {
      const prevSet = this.canvasIndex.get(entry.canvasId);
      if (prevSet) {
        prevSet.delete(connectionId);
        if (prevSet.size === 0) this.canvasIndex.delete(entry.canvasId);
      }
    }

    entry.canvasId = canvasId;

    let canvasSet = this.canvasIndex.get(canvasId);
    if (!canvasSet) {
      canvasSet = new Set();
      this.canvasIndex.set(canvasId, canvasSet);
    }
    canvasSet.add(connectionId);
  }

  /** Mark a run as active for a canvas. */
  setActiveRun(canvasId: string, runId: string): void {
    this.activeRuns.set(canvasId, { runId, startedAt: Date.now() });
  }

  /** Clear active run for a canvas. */
  clearActiveRun(canvasId: string): void {
    this.activeRuns.delete(canvasId);
  }

  /** Get active run info for a canvas, if any. */
  getActiveRun(canvasId: string): { runId: string; startedAt: number } | null {
    return this.activeRuns.get(canvasId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  /** Get the WebSocket for a specific connection. */
  get(connectionId: string): WebSocket | undefined {
    return this.connections.get(connectionId)?.ws;
  }

  /** Get the full ConnectionEntry for a specific connection. */
  getEntry(connectionId: string): ConnectionEntry | undefined {
    return this.connections.get(connectionId);
  }

  revokeClient(accessClientId: string): void {
    const failures: unknown[] = [];
    for (const entry of [...this.connections.values()]) {
      if (entry.accessClientId === accessClientId) {
        try {
          entry.ws.close(4001, "本机连接授权已撤销");
        } catch (error) {
          failures.push(error);
          try {
            entry.ws.terminate();
          } catch (failure) {
            failures.push(failure);
          }
        } finally {
          this.remove(entry.connectionId, entry.ws);
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        "接入已撤销，但部分WebSocket关闭尚未确认。",
      );
    }
  }

  /**
   * Get ANY open WebSocket for a user (backward compat).
   * Picks the first connection whose socket is still open.
   */
  getByInstance(instanceId: string): WebSocket | undefined {
    const ids = this.instanceIndex.get(instanceId);
    if (!ids) return undefined;
    for (const cid of ids) {
      const entry = this.connections.get(cid);
      if (entry && entry.ws.readyState === 1) return entry.ws;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Broadcasting (StreamEvent)
  // ---------------------------------------------------------------------------

  /** Send a StreamEvent to ALL connections viewing a specific canvas. */
  pushToCanvas(canvasId: string, event: StreamEvent): void {
    const ids = this.canvasIndex.get(canvasId);
    if (!ids) return;
    const payload = JSON.stringify({ type: "event", event });
    for (const cid of ids) {
      const entry = this.connections.get(cid);
      if (entry && entry.ws.readyState === 1) {
        entry.ws.send(payload);
      }
    }
  }

  /** Send a StreamEvent to ALL connections for a user. */
  pushToInstance(instanceId: string, event: StreamEvent): void {
    const ids = this.instanceIndex.get(instanceId);
    if (!ids) return;
    const payload = JSON.stringify({ type: "event", event });
    for (const cid of ids) {
      const entry = this.connections.get(cid);
      if (entry && entry.ws.readyState === 1) {
        entry.ws.send(payload);
      }
    }
  }

  /**
   * Backward-compatible push: send a StreamEvent to ANY connection for a user.
   * Delegates to pushToInstance (broadcasts to all).
   */
  push(instanceId: string, event: StreamEvent): void {
    this.pushToInstance(instanceId, event);
  }

  // ---------------------------------------------------------------------------
  // Direct messaging
  // ---------------------------------------------------------------------------

  /** Send a raw JSON message to a specific connection. */
  sendTo(connectionId: string, message: Record<string, unknown>): boolean {
    const entry = this.connections.get(connectionId);
    if (entry?.ws.readyState !== 1) return false;
    entry.ws.send(JSON.stringify(message));
    return true;
  }

  /**
   * Send a raw JSON message to ANY open connection for a user (backward compat).
   * Broadcasts to all open connections for the user and returns true if at least
   * one was delivered.
   */
  sendToUser(instanceId: string, message: Record<string, unknown>): boolean {
    const ids = this.instanceIndex.get(instanceId);
    if (!ids) return false;
    const payload = JSON.stringify(message);
    let delivered = false;
    for (const cid of ids) {
      const entry = this.connections.get(cid);
      if (entry && entry.ws.readyState === 1) {
        entry.ws.send(payload);
        delivered = true;
      }
    }
    return delivered;
  }

  /**
   * Backward-compatible send: delegates to sendToUser.
   */
  send(instanceId: string, message: Record<string, unknown>): boolean {
    return this.sendToUser(instanceId, message);
  }

  // ---------------------------------------------------------------------------
  // RPC (unchanged semantics, keyed by UUID)
  // ---------------------------------------------------------------------------

  /**
   * RPC to a specific connection by connectionId.
   */
  async rpc<T = unknown>(
    connectionId: string,
    method: string,
    params: Record<string, unknown>,
    timeout = 10_000,
  ): Promise<T> {
    // First try connectionId as a direct lookup
    let ws = this.connections.get(connectionId)?.ws;

    // Fallback: treat connectionId as instanceId for backward compat
    // (existing callers like screenshot-canvas pass instanceId)
    if (!ws) {
      ws = this.getByInstance(connectionId);
    }

    if (ws?.readyState !== 1) {
      throw new Error(`Connection ${connectionId} not available`);
    }

    const id = randomUUID();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRPCs.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pendingRPCs.set(id, { resolve, reject, timer });

      ws.send(
        JSON.stringify({
          type: "rpc.request",
          id,
          method,
          params,
        }),
      );
    });
  }

  /**
   * Handle an incoming RPC response. Keyed by the unique RPC request UUID,
   * so connectionId is accepted but not needed for dispatch.
   */
  handleRpcResponse(
    _connectionId: string,
    msg: { type: "rpc.response"; id: string; result?: unknown; error?: string },
  ): void {
    const pending = this.pendingRPCs.get(msg.id);
    if (!pending) return;

    this.pendingRPCs.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  dispose(): void {
    for (const pending of this.pendingRPCs.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ConnectionManager disposed"));
    }
    this.pendingRPCs.clear();
    this.connections.clear();
    this.instanceIndex.clear();
    this.canvasIndex.clear();
    this.activeRuns.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private removeFromIndexes(
    connectionId: string,
    entry: ConnectionEntry,
  ): void {
    // Remove from user index
    const userSet = this.instanceIndex.get(entry.instanceId);
    if (userSet) {
      userSet.delete(connectionId);
      if (userSet.size === 0) this.instanceIndex.delete(entry.instanceId);
    }

    // Remove from canvas index
    if (entry.canvasId) {
      const canvasSet = this.canvasIndex.get(entry.canvasId);
      if (canvasSet) {
        canvasSet.delete(connectionId);
        if (canvasSet.size === 0) this.canvasIndex.delete(entry.canvasId);
      }
    }
  }
}
