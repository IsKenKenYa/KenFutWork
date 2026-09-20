"use client";

import type {
  RunCreateRequest,
  StreamEvent,
  TerminalShellId,
  WsCommandAck,
  WsRpcRequest,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getServerBaseUrl } from "../lib/env";

type EventCallback = (event: StreamEvent) => void;

/**
 * 终端会话通道（右栏「终端」标签的交互式形态）的事件：起好了 / 有输出 / 结束了。
 * 与 run 事件分开：run 事件的消费方按 runId 过滤，把终端输出塞进去会让它们误判。
 */
export type TerminalChannelEvent =
  | {
      type: "started";
      sessionId: string;
      shell: TerminalShellId;
      executable: string;
    }
  | { type: "output"; sessionId: string; data: string }
  | {
      type: "exit";
      sessionId: string;
      exitCode: number | null;
      reason?: string;
    };

type TerminalCallback = (event: TerminalChannelEvent) => void;
type RPCHandler = (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type WebSocketHandle = {
  connected: boolean;
  startRun: (
    payload: RunCreateRequest,
    onAck?: (ack: WsCommandAck) => void,
  ) => void;
  cancelRun: (runId: string) => void;
  onEvent: (cb: EventCallback) => () => void;
  /** 起一个持久 shell 会话（同一个 id 重复起时服务端复用已有会话）。 */
  startTerminal: (payload: {
    sessionId: string;
    /** 省略即不绑工作目录（cwd 落到服务端启动目录）。 */
    canvasId?: string;
    shell?: TerminalShellId;
    /** PTY 的初始尺寸（列 × 行）；终端模拟器量出来后会再 resize 一次。 */
    cols?: number;
    rows?: number;
  }) => void;
  /** 终端尺寸变化（PSReadLine / 全屏 TUI 靠它排版）。 */
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  /** 送一行输入（换行由服务端按 shell 补）。 */
  sendTerminalInput: (sessionId: string, data: string) => void;
  /** 结束会话（服务端杀整棵进程树）。 */
  stopTerminal: (sessionId: string) => void;
  onTerminal: (cb: TerminalCallback) => () => void;
  registerRPC: (method: string, handler: RPCHandler) => () => void;
  resumeCanvas: (canvasId: string, onAck?: (ack: WsCommandAck) => void) => void;
  /**
   * 立刻换一条新连接（不等退避）。
   *
   * 用途：半开连接的自救——服务端那侧已经注销、客户端这侧 socket 还开着时，
   * `connected` 是假的 true，命令发得出去、事件回不来。此时把 socket 关掉重连，
   * 既有的重连对账（`resumeCanvas`）会把在飞的 run 接回来。
   */
  reconnectNow: () => void;
};

export function useWebSocket(getToken: () => string | null): WebSocketHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const connectionIdRef = useRef(
    (() => {
      if (typeof sessionStorage !== "undefined") {
        const stored = sessionStorage.getItem("ws_connection_id");
        if (stored) return stored;
        const id =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem("ws_connection_id", id);
        return id;
      }
      return typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    })(),
  );
  const [connected, setConnected] = useState(false);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposed = useRef(false);

  const eventListeners = useRef<Set<EventCallback>>(new Set());
  const terminalListeners = useRef<Set<TerminalCallback>>(new Set());
  const ackListeners = useRef<Map<string, (ack: WsCommandAck) => void>>(
    new Map(),
  );
  const rpcHandlers = useRef<Map<string, RPCHandler>>(new Map());

  // 只读 rpcHandlers ref，故空依赖数组即稳定引用；connect 依赖它才不违反 exhaustive-deps。
  const handleRpcRequest = useCallback(
    async (ws: WebSocket, req: WsRpcRequest) => {
      const handler = rpcHandlers.current.get(req.method);
      if (!handler) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "rpc.response",
              id: req.id,
              error: `No handler for method: ${req.method}`,
            }),
          );
        }
        return;
      }

      try {
        const result = await handler(req.params);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "rpc.response", id: req.id, result }));
        }
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "rpc.response",
              id: req.id,
              error:
                error instanceof Error ? error.message : "RPC handler failed",
            }),
          );
        }
      }
    },
    [],
  );

  const connect = useCallback(() => {
    const token = getToken();
    if (disposed.current) return;
    // Skip if already connected -- prevents React Strict Mode double-mount
    // from replacing an active connection mid-stream
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return;
    }
    // Close any existing connection before creating a new one
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent reconnect from old socket
      wsRef.current.close();
      wsRef.current = null;
    }
    if (!token) {
      // Token not yet available (auth loading) -- retry shortly
      reconnectTimer.current = setTimeout(connect, 500);
      return;
    }

    const serverBase = getServerBaseUrl();
    const wsBase = serverBase
      ? serverBase.replace(/^http/, "ws")
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
    const wsUrl =
      wsBase +
      `/api/ws?token=${encodeURIComponent(token)}&connectionId=${encodeURIComponent(connectionIdRef.current)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[ws] connected, connectionId:", connectionIdRef.current);
      setConnected(true);
      reconnectAttempt.current = 0;
    };

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch (err) {
        console.warn("[ws] failed to parse incoming message:", err);
        return;
      }

      if (msg.type === "event") {
        const streamEvent = msg.event as StreamEvent;
        // Defensive: skip malformed events without proper structure
        if (!streamEvent || typeof streamEvent !== "object") {
          console.warn("[ws] received malformed stream event:", msg);
          return;
        }
        for (const cb of eventListeners.current) {
          try {
            cb(streamEvent);
          } catch (listenerErr) {
            // Prevent one listener's error from breaking others
            console.error("[ws] event listener threw:", listenerErr);
          }
        }
      } else if (
        msg.type === "terminal.output" ||
        msg.type === "terminal.exit"
      ) {
        const terminalEvent: TerminalChannelEvent =
          msg.type === "terminal.output"
            ? {
                type: "output",
                sessionId: String(msg.sessionId ?? ""),
                data: String(msg.data ?? ""),
              }
            : {
                type: "exit",
                sessionId: String(msg.sessionId ?? ""),
                exitCode:
                  typeof msg.exitCode === "number" ? msg.exitCode : null,
                ...(typeof msg.reason === "string"
                  ? { reason: msg.reason }
                  : {}),
              };
        for (const cb of terminalListeners.current) {
          try {
            cb(terminalEvent);
          } catch (listenerErr) {
            console.error("[ws] terminal listener threw:", listenerErr);
          }
        }
      } else if (
        msg.type === "command.ack" &&
        msg.action === "terminal.start"
      ) {
        const payload = (msg.payload ?? {}) as Record<string, unknown>;
        const started: TerminalChannelEvent = {
          type: "started",
          sessionId: String(payload.sessionId ?? ""),
          shell: (payload.shell ?? "auto") as TerminalShellId,
          executable: String(payload.executable ?? ""),
        };
        for (const cb of terminalListeners.current) {
          try {
            cb(started);
          } catch (listenerErr) {
            console.error("[ws] terminal listener threw:", listenerErr);
          }
        }
      } else if (msg.type === "command.ack") {
        const cb = ackListeners.current.get(msg.action as string);
        if (cb) {
          ackListeners.current.delete(msg.action as string);
          try {
            cb(msg as unknown as WsCommandAck);
          } catch (ackErr) {
            console.error("[ws] ack listener threw:", ackErr);
          }
        }
      } else if (msg.type === "rpc.request") {
        void handleRpcRequest(ws, msg as unknown as WsRpcRequest);
      }
      // Unknown message types are silently ignored -- server may add new types
    };

    ws.onclose = (event) => {
      // Only handle close for the CURRENT connection.
      // React Strict Mode creates two connections; when the server replaces
      // the old one, its close event fires after remount resets disposed=false.
      // Without this guard, we'd enter a reconnect loop.
      if (wsRef.current !== ws) return;

      setConnected(false);
      wsRef.current = null;

      if (event.code === 4001) {
        console.warn("[ws] Auth rejected, will retry with fresh token");
      }

      if (!disposed.current) {
        const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt.current);
        const attempt = reconnectAttempt.current + 1;
        console.log(
          `[ws] scheduling reconnect attempt ${attempt} in ${delay}ms (code: ${event.code})`,
        );
        reconnectAttempt.current = attempt;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [getToken, handleRpcRequest]);

  useEffect(() => {
    disposed.current = false;
    connect();
    return () => {
      disposed.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const sendCommand = useCallback(
    (action: string, payload: Record<string, unknown>): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn(
          "[ws] command dropped -- not connected, readyState:",
          ws?.readyState,
        );
        return false;
      }
      try {
        ws.send(JSON.stringify({ type: "command", action, payload }));
        return true;
      } catch (err) {
        // Guard against serialization errors (e.g. circular refs in payload)
        console.error("[ws] failed to send command:", action, err);
        return false;
      }
    },
    [],
  );

  const startRun = useCallback(
    (payload: RunCreateRequest, onAck?: (ack: WsCommandAck) => void) => {
      if (onAck) {
        ackListeners.current.set("agent.run", onAck);
      }
      const sent = sendCommand(
        "agent.run",
        payload as unknown as Record<string, unknown>,
      );
      if (!sent) {
        // Remove the dangling ack listener so callers don't hang forever
        ackListeners.current.delete("agent.run");
      }
    },
    [sendCommand],
  );

  const cancelRun = useCallback(
    (runId: string) => {
      sendCommand("agent.cancel", { runId });
    },
    [sendCommand],
  );

  const reconnectNow = useCallback(() => {
    reconnectAttempt.current = 0;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    const stale = wsRef.current;
    if (stale) {
      // 由我们自己接管重连：摘掉 onclose，免得它再调度一次
      stale.onclose = null;
      wsRef.current = null;
      try {
        stale.close();
      } catch {
        // 关一个已经坏掉的 socket 会抛，忽略
      }
    }
    setConnected(false);
    connect();
  }, [connect]);

  const resumeCanvas = useCallback(
    (canvasId: string, onAck?: (ack: WsCommandAck) => void) => {
      if (onAck) {
        ackListeners.current.set("canvas.resume", onAck);
      }
      const sent = sendCommand("canvas.resume", { canvasId, lastSeq: 0 });
      if (!sent) {
        ackListeners.current.delete("canvas.resume");
      }
    },
    [sendCommand],
  );

  const startTerminal = useCallback(
    (payload: {
      sessionId: string;
      canvasId?: string;
      shell?: TerminalShellId;
      cols?: number;
      rows?: number;
    }) => {
      sendCommand(
        "terminal.start",
        payload as unknown as Record<string, unknown>,
      );
    },
    [sendCommand],
  );

  const resizeTerminal = useCallback(
    (sessionId: string, cols: number, rows: number) => {
      sendCommand("terminal.resize", { sessionId, cols, rows });
    },
    [sendCommand],
  );

  const sendTerminalInput = useCallback(
    (sessionId: string, data: string) => {
      sendCommand("terminal.input", { sessionId, data });
    },
    [sendCommand],
  );

  const stopTerminal = useCallback(
    (sessionId: string) => {
      sendCommand("terminal.stop", { sessionId });
    },
    [sendCommand],
  );

  const onTerminal = useCallback((cb: TerminalCallback) => {
    terminalListeners.current.add(cb);
    return () => {
      terminalListeners.current.delete(cb);
    };
  }, []);

  const onEvent = useCallback((cb: EventCallback) => {
    eventListeners.current.add(cb);
    return () => {
      eventListeners.current.delete(cb);
    };
  }, []);

  const registerRPC = useCallback((method: string, handler: RPCHandler) => {
    rpcHandlers.current.set(method, handler);
    return () => {
      rpcHandlers.current.delete(method);
    };
  }, []);

  return {
    connected,
    startRun,
    cancelRun,
    onEvent,
    registerRPC,
    resumeCanvas,
    startTerminal,
    resizeTerminal,
    sendTerminalInput,
    stopTerminal,
    onTerminal,
    reconnectNow,
  };
}
