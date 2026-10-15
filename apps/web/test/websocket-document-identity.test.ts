import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../src/lib/env", () => ({
  getServerBaseUrl: () => "http://local.test",
}));

import { useWebSocket } from "../src/hooks/use-websocket";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCount = 0;
  sent: string[] = [];
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close(code = 1000) {
    this.closeCount++;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  send(data: string) {
    this.sent.push(data);
  }
  get id() {
    return new URL(this.url).searchParams.get("connectionId");
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  sessionStorage.clear();
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("两个同文档编辑器实例使用不同连接ID，普通旧调用保持原storage身份", () => {
  sessionStorage.setItem("ws_connection_id", "legacy-id");
  renderHook(() => useWebSocket({ documentScope: "canvas-a" }));
  renderHook(() => useWebSocket({ documentScope: "canvas-a" }));
  renderHook(() => useWebSocket());
  expect(Socket.instances).toHaveLength(3);
  expect(Socket.instances[0]?.id).not.toBe(Socket.instances[1]?.id);
  expect(Socket.instances[0]?.id).not.toBe("legacy-id");
  expect(Socket.instances[2]?.id).toBe("legacy-id");
  expect(sessionStorage.getItem("ws_connection_id")).toBe("legacy-id");
});

test("同实例重连保留ID，旧socket迟到close不删除新连接，卸载释放socket与timer", async () => {
  const hook = renderHook(() => useWebSocket({ documentScope: "canvas-a" }));
  const first = Socket.instances[0];
  if (!first) throw new Error("Missing socket");
  act(() => first.open());
  const id = first.id;
  act(() => first.close(1006));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const second = Socket.instances[1];
  if (!second) throw new Error("Missing replacement socket");
  expect(second.id).toBe(id);
  act(() => second.open());
  act(() => first.onclose?.({ code: 1006 }));
  expect(hook.result.current.connected).toBe(true);
  hook.unmount();
  expect(second.closeCount).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("文档通知使用独立订阅和共享schema，坏目标不进入Agent流，解除监听后不投递", () => {
  const hook = renderHook(() => useWebSocket({ documentScope: "canvas-a" }));
  const socket = Socket.instances[0];
  if (!socket) throw new Error("Missing socket");
  const event = vi.fn();
  const updated = vi.fn();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const releaseEvent = hook.result.current.onEvent(event);
  const releaseBroken = hook.result.current.onDocumentUpdated(() => {
    throw new Error("broken listener");
  });
  const release = hook.result.current.onDocumentUpdated(updated);
  const message = {
    type: "canvas.document.updated",
    canvasId: "20000000-0000-4000-8000-000000000001",
    projectId: "10000000-0000-4000-8000-000000000001",
    revision: "a".repeat(64),
    deleted: false,
  };
  socket.onmessage?.({
    data: JSON.stringify({ ...message, canvasId: "invalid" }),
  });
  socket.onmessage?.({
    data: JSON.stringify({ ...message, revision: "invalid" }),
  });
  expect(updated).not.toHaveBeenCalled();
  socket.onmessage?.({ data: JSON.stringify(message) });
  expect(updated).toHaveBeenCalledWith(message);
  expect(error).toHaveBeenCalledOnce();
  expect(event).not.toHaveBeenCalled();
  release();
  releaseBroken();
  releaseEvent();
  socket.onmessage?.({ data: JSON.stringify({ ...message, deleted: true }) });
  expect(updated).toHaveBeenCalledOnce();
  error.mockRestore();
});
