import { Socket } from "node:net";
import { join } from "node:path";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { createAgentRunService } from "../agent/runtime.js";
import { loadServerEnv } from "../config/env.js";
import { createLocalFsBlobStore } from "../features/blob/providers/local-fs.js";
import { createLocalAccessFixture } from "../features/local-access/test-fixture.js";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

async function fixture() {
  const access = await createLocalAccessFixture();
  const manager = new ConnectionManager();
  const app = Fastify();
  await app.register(websocket);
  const peer = new Socket();
  Object.defineProperty(peer, "remoteAddress", { value: "127.0.0.1" });
  const agentRuns = createAgentRunService({
    localInstance: access.options.instance,
    env: loadServerEnv({ desktopDataDir: access.dataDir }, {}),
    blob: createLocalFsBlobStore({
      rootDir: join(access.dataDir, "blobs"),
      publicBaseUrl: "http://127.0.0.1/api/blobs",
      signingSecret: "transport-fixture-only",
    }),
  });
  await registerWsRoute(app, {
    agentRuns,
    localAccess: access.service,
    localInstance: access.options.instance,
    connectionManager: manager,
  });
  await app.ready();
  const clients: WebSocket[] = [];
  return {
    ...access,
    app,
    manager,
    async connect(
      id: string,
      headers = access.request.headers,
      onInit?: (socket: WebSocket) => void,
    ) {
      const client = await app.injectWS(
        `/api/ws?connectionId=${encodeURIComponent(id)}`,
        {
          socket: peer,
          headers: { host: "127.0.0.1", ...headers },
        },
        { ...(onInit ? { onInit } : {}) },
      );
      clients.push(client);
      return client;
    },
    async close() {
      for (const client of clients) client.terminate();
      await app.close();
      manager.dispose();
      peer.destroy();
      await access.cleanup();
    },
  };
}

function closing(client: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    client.once("close", (code) => resolve(code));
  });
}

describe("WS本机客户端连接身份与心跳准入", () => {
  it("不同client不能抢connectionId；同client重连关闭旧socket，旧close不删新注册", async () => {
    const data = await fixture();
    try {
      const first = await data.service.createApiClient(data.request, {
        label: "first",
      });
      const other = await data.service.createApiClient(data.request, {
        label: "other",
      });
      const headers = { authorization: `Bearer ${first.token}` };
      const old = await data.connect("same", headers);
      await vi.waitFor(() =>
        expect(data.manager.getEntry("same")?.accessClientId).toBe(
          first.client.id,
        ),
      );
      let foreignClosed!: Promise<number>;
      await data.connect(
        "same",
        { authorization: `Bearer ${other.token}` },
        (client) => {
          foreignClosed = closing(client);
        },
      );
      expect(await foreignClosed).toBe(4001);
      expect(data.manager.getEntry("same")?.accessClientId).toBe(
        first.client.id,
      );
      const oldClosed = closing(old);
      const oldServer = data.manager.get("same");
      await data.connect("same", headers);
      expect(await oldClosed).toBe(4000);
      await vi.waitFor(() =>
        expect(data.manager.get("same")).not.toBe(oldServer),
      );
      expect(data.manager.getEntry("same")?.accessClientId).toBe(
        first.client.id,
      );
    } finally {
      await data.close();
    }
  });

  it("首个认证期间撤权不能进入连接索引，数据库错误使用1011", async () => {
    const data = await fixture();
    try {
      const issued = await data.service.createApiClient(data.request, {
        label: "race",
      });
      const authenticate = data.service.authenticate.bind(data.service);
      let first = true;
      vi.spyOn(data.service, "authenticate").mockImplementation(
        async (request) => {
          const actor = await authenticate(request);
          if (first) {
            first = false;
            await data.service.revokeClient(data.request, issued.client.id);
          }
          return actor;
        },
      );
      let expired!: Promise<number>;
      await data.connect(
        "withdrawn",
        { authorization: `Bearer ${issued.token}` },
        (client) => {
          expired = closing(client);
        },
      );
      expect(await expired).toBe(4001);
      expect(data.manager.get("withdrawn")).toBeUndefined();
      vi.spyOn(data.service, "authenticate").mockRejectedValue(
        new Error("数据库不可用"),
      );
      let failed!: Promise<number>;
      await data.connect("unavailable", data.request.headers, (client) => {
        failed = closing(client);
      });
      expect(await failed).toBe(1011);
      expect(data.manager.get("unavailable")).toBeUndefined();
    } finally {
      await data.close();
    }
  });

  it("自然过期的被动browser连接在既有心跳关闭，慢认证保持single-flight", async () => {
    const data = await fixture();
    const ticket = await data.service.issueTicket(data.request);
    const browser = await data.service.consumeTicket(
      { ip: "127.0.0.1", headers: {} },
      ticket,
    );
    const headers = { cookie: browser.cookie.split(";")[0] ?? "" };
    vi.useFakeTimers();
    try {
      const client = await data.connect("expiry", headers);
      await vi.waitFor(() => expect(data.manager.get("expiry")).toBeTruthy());
      const closed = closing(client);
      data.advance(60_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await closed).toBe(4001);
      expect(data.manager.get("expiry")).toBeUndefined();
      const active = await data.connect("slow");
      await vi.waitFor(() => expect(data.manager.get("slow")).toBeTruthy());
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const authenticate = data.service.authenticate.bind(data.service);
      const query = vi
        .spyOn(data.service, "authenticate")
        .mockImplementation(async (request) => {
          await blocked;
          return authenticate(request);
        });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(query).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(0);
      active.terminate();
    } finally {
      vi.useRealTimers();
      await data.close();
    }
  });

  it("被动心跳查库异常关闭1011，不继续ping或保留索引", async () => {
    const data = await fixture();
    vi.useFakeTimers();
    try {
      const client = await data.connect("db-heartbeat");
      await vi.waitFor(() =>
        expect(data.manager.get("db-heartbeat")).toBeTruthy(),
      );
      const closed = closing(client);
      vi.spyOn(data.service, "authenticate").mockRejectedValue(
        new Error("数据库断开"),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await closed).toBe(1011);
      expect(data.manager.get("db-heartbeat")).toBeUndefined();
    } finally {
      vi.useRealTimers();
      await data.close();
    }
  });
});
