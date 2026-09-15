import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { ConnectionManager } from "./connection-manager.js";

function fakeSocket() {
  const socket = { readyState: 1, sent: [] as string[] };
  return Object.assign(socket, {
    send: (data: string) => {
      socket.sent.push(data);
    },
  });
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

    manager.register(
      "conn-reused",
      "user-1",
      oldSocket as unknown as WebSocket,
    );
    // 重连：同一 id 的新 socket 顶掉旧注册
    manager.register(
      "conn-reused",
      "user-1",
      newSocket as unknown as WebSocket,
    );

    // 旧 socket 的 close 迟到触发 remove —— 必须因 socket 身份不匹配而 no-op
    manager.remove("conn-reused", oldSocket as unknown as WebSocket);
    expect(manager.sendTo("conn-reused", { type: "probe" })).toBe(true);
    expect(newSocket.sent).toEqual(['{"type":"probe"}']);

    // 新 socket 自己 close 才真正删除
    manager.remove("conn-reused", newSocket as unknown as WebSocket);
    expect(manager.sendTo("conn-reused", { type: "probe" })).toBe(false);
  });

  it("不带 socket 的 remove 保持旧语义（无身份校验直接删）", () => {
    const manager = new ConnectionManager();
    const socket = fakeSocket();
    manager.register("conn-plain", "user-1", socket as unknown as WebSocket);
    manager.remove("conn-plain");
    expect(manager.sendTo("conn-plain", { type: "probe" })).toBe(false);
  });
});
