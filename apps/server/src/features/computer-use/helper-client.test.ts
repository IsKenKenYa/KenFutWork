import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HelperClient, HelperRpcError } from "./helper-client.js";

const token = "a".repeat(64);
let directory: string;
let socketPath: string;
let server: Server;
let sockets: Socket[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kfw-helper-client-"));
  socketPath = join(directory, "helper.sock");
  sockets = [];
  server = createServer((socket) => {
    sockets.push(socket);
    let buffer = "";
    let authenticated = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line) as {
          id: string;
          method: string;
          params?: Record<string, unknown>;
        };
        if (request.method === "hello") {
          if (request.params?.token !== token) {
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: false,
                error: { code: "unauthorized", message: "token 错误" },
              })}\n`,
            );
            socket.end();
            continue;
          }
          authenticated = true;
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: {
                protocolVersion: 1,
                helperVersion: "0.1.0",
                bundleId: "com.kenfutwork.cua-helper.test",
                pid: 123,
                teamIdentifier: "TEAM",
                permissions: {
                  accessibility: "denied",
                  screenRecording: "denied",
                },
              },
            })}\n`,
          );
          continue;
        }
        if (!authenticated) {
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: false,
              error: { code: "unauthorized", message: "未握手" },
            })}\n`,
          );
          socket.end();
          continue;
        }
        if (request.method === "ping")
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: { pong: true },
            })}\n`,
          );
        else if (request.method === "permission.status")
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: {
                available: true,
                helperBundleId: "com.kenfutwork.cua-helper.test",
                helperPath: "/Applications/Helper.app",
                teamIdentifier: "TEAM",
                accessibility: "denied",
                screenRecording: "denied",
                grantOwner: "/Applications/Helper.app",
              },
            })}\n`,
          );
        else if (request.method === "slow") {
          // 由测试主动等待超时。
        } else
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: false,
              error: {
                code: "method_not_found",
                message: "未知方法",
                actionSent: false,
              },
            })}\n`,
          );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

it("握手后请求 ping 与 permission.status，返回真实 socket 结果", async () => {
  const client = await HelperClient.connect({
    socketPath,
    token,
    timeoutMs: 1_000,
  });
  try {
    await expect(client.request("ping")).resolves.toEqual({ pong: true });
    await expect(client.request("permission.status")).resolves.toMatchObject({
      available: true,
      accessibility: "denied",
      screenRecording: "denied",
      grantOwner: "/Applications/Helper.app",
    });
  } finally {
    client.close();
  }
});

it("错误 token 在握手阶段失败，不进入已连接状态", async () => {
  await expect(
    HelperClient.connect({
      socketPath,
      token: "b".repeat(64),
      timeoutMs: 1_000,
    }),
  ).rejects.toMatchObject({ code: "unauthorized" });
});

it("Helper 返回错误响应时保留 code、message 与 actionSent", async () => {
  const client = await HelperClient.connect({
    socketPath,
    token,
    timeoutMs: 1_000,
  });
  try {
    await expect(client.request("unknown")).rejects.toMatchObject({
      code: "method_not_found",
      actionSent: false,
    });
  } finally {
    client.close();
  }
});

it("请求超时只失败当前请求，迟到响应不复活客户端状态", async () => {
  const client = await HelperClient.connect({
    socketPath,
    token,
    timeoutMs: 100,
  });
  await expect(client.request("slow")).rejects.toMatchObject({
    code: "timeout",
  });
  expect(client.socketDestroyed).toBe(false);
  client.close();
  await expect(client.request("ping")).rejects.toBeInstanceOf(HelperRpcError);
});

it("连接被关闭后所有等待中的请求都失败", async () => {
  const client = await HelperClient.connect({
    socketPath,
    token,
    timeoutMs: 1_000,
  });
  const pending = client.request("slow");
  sockets[0]?.destroy();
  await expect(pending).rejects.toMatchObject({ code: "disconnected" });
  client.close();
});

it("socket 不存在时连接失败，错误包含可读原因", async () => {
  await expect(
    HelperClient.connect({
      socketPath: join(directory, "missing.sock"),
      token,
      timeoutMs: 100,
    }),
  ).rejects.toMatchObject({ code: "connect_failed" });
});

it("客户端关闭后迟到的请求被拒绝", async () => {
  const client = await HelperClient.connect({
    socketPath,
    token,
    timeoutMs: 1_000,
  });
  client.close();
  await expect(client.request("ping")).rejects.toMatchObject({
    code: "disconnected",
  });
});
