import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { ConnectionManager } from "./connection-manager.js";

function fakeSocket() {
  // ws内部服务端构造确实接收3参数；@types/ws的null重载只声明1参数。
  // 显式构造器契约保持真实WebSocket，不以类型断言或伪socket掩盖差异。
  const ServerSocket: new (
    address: null,
    protocols: undefined,
    options: { autoPong: boolean },
  ) => WebSocket = WebSocket;
  const socket = new ServerSocket(null, undefined, { autoPong: true });
  let open = true;
  const sent: string[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  Object.defineProperty(socket, "readyState", {
    get: () => (open ? WebSocket.OPEN : WebSocket.CLOSED),
  });
  vi.spyOn(socket, "send").mockImplementation((data) => {
    sent.push(String(data));
  });
  vi.spyOn(socket, "close").mockImplementation((code, reason) => {
    open = false;
    closed.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason: String(reason) }),
    });
    socket.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  });
  vi.spyOn(socket, "terminate").mockImplementation(() => {
    open = false;
    socket.emit("close", 1006, Buffer.alloc(0));
  });
  return Object.assign(socket, { sent, closed });
}

/**
 * 回归：connectionId 由客户端提供且重连时**复用**（handler 查询参数）。
 * 曾经的坑：新 socket 用同一 id 重新 register 后，旧 socket 迟到的 close 事件
 * 调 remove(connectionId) 把**新注册**删掉——连接活着但 map entry 没了，
 * run 的 ack/流式事件全部 delivered=false（消息进得来、推送出不去，实测整轮假失败）。
 */
describe("ConnectionManager 重连身份校验", () => {
  it("旧 socket 迟到的 close 不得删除新 socket 的注册", () => {
    const manager = new ConnectionManager();
    const oldSocket = fakeSocket();
    const newSocket = fakeSocket();

    manager.register("conn-reused", "user-1", oldSocket);
    // 重连：同一 id 的新 socket 顶掉旧注册
    manager.register("conn-reused", "user-1", newSocket);

    // 旧 socket 的 close 迟到触发 remove —— 必须因 socket 身份不匹配而 no-op
    manager.remove("conn-reused", oldSocket);
    expect(manager.sendTo("conn-reused", { type: "probe" })).toBe(true);
    expect(newSocket.sent).toEqual(['{"type":"probe"}']);

    // 新 socket 自己 close 才真正删除
    manager.remove("conn-reused", newSocket);
    expect(manager.sendTo("conn-reused", { type: "probe" })).toBe(false);
  });

  it("不带 socket 的 remove 保持旧语义（无身份校验直接删）", () => {
    const manager = new ConnectionManager();
    const socket = fakeSocket();
    manager.register("conn-plain", "user-1", socket);
    manager.remove("conn-plain");
    expect(manager.sendTo("conn-plain", { type: "probe" })).toBe(false);
  });

  it("外来client或instance不能抢同connectionId，原连接和索引不受影响", () => {
    const manager = new ConnectionManager();
    const owner = fakeSocket();
    const foreign = fakeSocket();
    manager.register("shared-id", "instance-A", owner, "client-A");
    manager.bindCanvas("shared-id", "canvas-A");
    expect(() =>
      manager.register("shared-id", "instance-A", foreign, "client-B"),
    ).toThrow("不能接管");
    expect(() =>
      manager.register("shared-id", "instance-B", foreign, "client-A"),
    ).toThrow("不能接管");
    expect(manager.get("shared-id")).toBe(owner);
    expect(manager.getEntry("shared-id")?.canvasId).toBe("canvas-A");
    expect(owner.closed).toHaveLength(0);
    expect(manager.sendTo("shared-id", { type: "still-owned" })).toBe(true);
  });

  it("同client重连关闭旧socket，迟到close不误删新entry；close抛错仍保留新entry", () => {
    const manager = new ConnectionManager();
    const oldSocket = fakeSocket();
    const next = fakeSocket();
    manager.register("same-id", "instance-A", oldSocket, "client-A");
    oldSocket.once("close", () => manager.remove("same-id", oldSocket));
    manager.register("same-id", "instance-A", next, "client-A");
    expect(oldSocket.closed).toEqual([
      { code: 4000, reason: "同一本机客户端已重新连接" },
    ]);
    expect(manager.get("same-id")).toBe(next);
    const replacement = fakeSocket();
    vi.spyOn(next, "close").mockImplementation(() => {
      throw new Error("transport close failed");
    });
    manager.register("same-id", "instance-A", replacement, "client-A");
    expect(manager.get("same-id")).toBe(replacement);
    expect(next.terminate).toHaveBeenCalledOnce();
  });

  it("同client多socket撤权时一个关闭失败仍关闭全部，索引清空并可读报告失败", () => {
    const manager = new ConnectionManager();
    const failed = fakeSocket();
    const second = fakeSocket();
    const other = fakeSocket();
    manager.register("failed", "instance-A", failed, "client-A");
    manager.register("second", "instance-A", second, "client-A");
    manager.register("other", "instance-A", other, "client-B");
    vi.spyOn(failed, "close").mockImplementation(() => {
      throw new Error("transport close failed");
    });
    expect(() => manager.revokeClient("client-A")).toThrow(
      "部分WebSocket关闭尚未确认",
    );
    expect(second.closed[0]?.code).toBe(4001);
    expect(manager.get("failed")).toBeUndefined();
    expect(manager.get("second")).toBeUndefined();
    expect(manager.get("other")).toBe(other);
  });
});
