import {
  AGENT_GOVERNANCE_DEFAULTS,
  type CodeUiEvent,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import Fastify, { type FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { CodeUiConnections } from "../features/code-ui/connections.js";
import { CodeUiControllerHost } from "../features/code-ui/controller.js";
import { createLocalAccessFixture } from "../features/local-access/test-fixture.js";
import { registerCodeUiRoutes } from "./code-ui.js";

type RoutesService = Parameters<typeof registerCodeUiRoutes>[1]["service"];

async function fixture(browser = false, realController = false) {
  const access = await createLocalAccessFixture();
  const script = await access.service.createApiClient(access.request, {
    label: "SSE客户端",
  });
  const ticket = browser
    ? await access.service.issueTicket(access.request)
    : null;
  const connected = ticket
    ? await access.service.consumeTicket(
        { ip: "127.0.0.1", headers: {} },
        ticket,
      )
    : null;
  const headers = connected
    ? { cookie: connected.cookie.split(";")[0] ?? "" }
    : { authorization: `Bearer ${script.token}` };
  const connections = new CodeUiConnections();
  let controller: CodeUiControllerHost | undefined;
  const disposeSource = vi.fn(async () => {});
  const deliveryFailed = vi.fn();
  const dispose = vi.fn(async () => {
    await controller?.dispose();
  });
  const closeConnections = vi.fn(async () => {
    await controller?.dispose();
    connections.closeAll();
  });
  let beforeOpen: (() => Promise<void>) | undefined;
  let streamReply: FastifyReply | undefined;
  let connectionId: string | undefined;
  let send: ((event: CodeUiEvent) => Promise<void>) | undefined;
  let notifyReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    notifyReady = resolve;
  });
  const unused = async (): Promise<never> => {
    throw new Error("此事件流夹具不消费RPC方法。");
  };
  const service: RoutesService = {
    async openConnection(actor, sender, close) {
      await beforeOpen?.();
      send = sender;
      const opened = connections.open(
        actor.instanceId,
        actor.instanceId,
        sender,
        close,
      );
      connectionId = opened.hello.connectionId;
      if (realController)
        controller = new CodeUiControllerHost({
          sources: async () => [],
          sourceCall: unused,
          send: sender,
          disposeSource,
          deliveryFailed,
        });
      return {
        ...opened,
        reconnectDelayMs: AGENT_GOVERNANCE_DEFAULTS.codeUiReconnectDelayMs,
        async dispose() {
          opened.dispose();
          await dispose();
        },
      };
    },
    closeConnections,
    listWorkspaces: unused,
    getSnapshot: unused,
    hostRpc: unused,
    transportRpc: unused,
    modelViews: unused,
    createSession: unused,
  };
  const listeners = new Set<(clientId: string) => void>();
  const subscribeOriginal = access.service.onRevoked.bind(access.service);
  vi.spyOn(access.service, "onRevoked").mockImplementation((listener) => {
    listeners.add(listener);
    const unsubscribe = subscribeOriginal(listener);
    return () => {
      listeners.delete(listener);
      unsubscribe();
    };
  });
  const app = Fastify();
  app.addHook("onRequest", async (request, reply) => {
    if (request.url !== "/api/code-ui/events") return;
    streamReply = reply;
    const write = reply.raw.write.bind(reply.raw);
    vi.spyOn(reply.raw, "write").mockImplementation(
      (chunk: unknown, ...args: unknown[]) => {
        const result = Reflect.apply(write, reply.raw, [chunk, ...args]);
        if (typeof chunk === "string" && chunk.includes('"event":"ready"'))
          notifyReady();
        return result;
      },
    );
  });
  await registerCodeUiRoutes(app, { localAccess: access.service, service });
  return {
    ...access,
    app,
    script,
    headers,
    ready,
    dispose,
    disposeSource,
    deliveryFailed,
    closeConnections,
    listeners,
    connections,
    routesService: service,
    pauseOpen(callback: () => Promise<void>) {
      beforeOpen = callback;
    },
    reply: () => streamReply,
    getConnectionId: () => connectionId,
    sender: () => send,
    controller: () => {
      if (!controller) throw new Error("此夹具未启用真实Controller。");
      return controller;
    },
    inject: () =>
      app
        .inject({ method: "GET", url: "/api/code-ui/events", headers })
        .then((response) => response),
    async close() {
      await app.close();
      await access.cleanup();
    },
  };
}

describe("Code事件流本机撤权", () => {
  it("对应accessClientId撤销后真实结束响应并dispose，其它客户端不受影响", async () => {
    const data = await fixture();
    try {
      const pending = data.inject();
      await data.ready;
      expect(data.listeners.size).toBe(1);
      const other = await data.service.createApiClient(data.request, {
        label: "其它客户端",
      });
      await data.service.revokeClient(data.request, other.client.id);
      expect(data.reply()?.raw.writableEnded).toBe(false);
      expect(data.dispose).not.toHaveBeenCalled();
      await data.service.revokeClient(data.request, data.script.client.id);
      const response = await pending;
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"event":"ready"');
      await vi.waitFor(() => expect(data.dispose).toHaveBeenCalledTimes(1));
      expect(data.listeners.size).toBe(0);
      expect(data.reply()?.raw.writableEnded).toBe(true);
      expect(() =>
        data.connections.require(
          data.instanceId,
          data.getConnectionId(),
          false,
        ),
      ).toThrow("已关闭");
    } finally {
      await data.close();
    }
  });

  it("握手成功但监听注册之前已撤权，第二次认证拒绝且不创建连接", async () => {
    const data = await fixture();
    try {
      const authenticate = data.service.authenticate.bind(data.service);
      let first = true;
      vi.spyOn(data.service, "authenticate").mockImplementation(
        async (request) => {
          const actor = await authenticate(request);
          if (first) {
            first = false;
            await data.service.revokeClient(
              data.request,
              data.script.client.id,
            );
          }
          return actor;
        },
      );
      const response = await data.inject();
      expect(response.statusCode).toBe(401);
      expect(data.getConnectionId()).toBeUndefined();
      expect(data.listeners.size).toBe(0);
      expect(data.dispose).not.toHaveBeenCalled();
    } finally {
      await data.close();
    }
  });

  it("openConnection准备期间撤权，迟到连接立即dispose且不发送ready", async () => {
    const data = await fixture();
    let resume!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    data.pauseOpen(async () => {
      entered();
      await blocked;
    });
    try {
      const pending = data.inject();
      await entering;
      const revoking = data.service.revokeClient(
        data.request,
        data.script.client.id,
      );
      await vi.waitFor(() => expect(data.listeners.size).toBe(0));
      resume();
      await revoking;
      const response = await pending;
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('"event":"ready"');
      expect(data.dispose).toHaveBeenCalledTimes(1);
    } finally {
      resume();
      await data.close();
    }
  });

  it("自然关闭与preClose均注销监听、关闭响应、一次性释放资源", async () => {
    const data = await fixture();
    try {
      const pending = data.inject();
      await data.ready;
      data.reply()?.raw.end();
      await pending;
      await vi.waitFor(() => expect(data.dispose).toHaveBeenCalledTimes(1));
      expect(data.listeners.size).toBe(0);
      await data.app.close();
      expect(data.dispose).toHaveBeenCalledTimes(1);
      expect(data.closeConnections).toHaveBeenCalledTimes(1);
    } finally {
      await data.close();
    }
    const shutdown = await fixture();
    try {
      const pending = shutdown.inject();
      await shutdown.ready;
      await shutdown.app.close();
      expect((await pending).statusCode).toBe(200);
      expect(shutdown.listeners.size).toBe(0);
      expect(shutdown.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await shutdown.close();
    }
  });

  it("连接准备失败不保留撤权监听", async () => {
    const data = await fixture();
    data.pauseOpen(async () => {
      throw new Error("真实宿主准备失败");
    });
    try {
      const failed = await data.inject();
      expect(failed.statusCode).toBe(500);
      expect(data.listeners.size).toBe(0);
      expect(data.dispose).not.toHaveBeenCalled();
    } finally {
      await data.close();
    }
  });

  it("未提供撤权能力的consumer facade不能建立事件流", async () => {
    const data = await fixture();
    const app = Fastify();
    try {
      await registerCodeUiRoutes(app, {
        localAccess: {
          authenticate: data.service.authenticate.bind(data.service),
        },
        service: data.routesService,
      });
      const response = await app.inject({
        method: "GET",
        url: "/api/code-ui/events",
        headers: data.headers,
      });
      expect(response.statusCode).toBe(503);
      expect(data.getConnectionId()).toBeUndefined();
      expect(data.listeners.size).toBe(0);
    } finally {
      await app.close();
      await data.close();
    }
  });

  it("浏览器会话自然过期后发送新帧会关闭SSE，不能泄漏新数据", async () => {
    const data = await fixture(true);
    try {
      const pending = data.inject();
      await data.ready;
      data.advance(60_000);
      await data.sender()?.({
        event: "service",
        service: "fixture",
        name: "private-after-expiry",
        data: { secret: "不得发送" },
      });
      const response = await pending;
      expect(response.body).not.toContain("private-after-expiry");
      expect(response.body).not.toContain("不得发送");
      await vi.waitFor(() => expect(data.dispose).toHaveBeenCalledTimes(1));
      expect(data.dispose).toHaveBeenCalledTimes(1);
      expect(data.listeners.size).toBe(0);
    } finally {
      await data.close();
    }
  });

  it("发送前查库故障关闭事件流，保留已发送ready而不追加私有帧", async () => {
    const data = await fixture();
    try {
      const pending = data.inject();
      await data.ready;
      vi.spyOn(data.service, "authenticate").mockRejectedValue(
        new Error("数据库断开"),
      );
      await data.sender()?.({
        event: "service",
        service: "fixture",
        name: "db-failed-frame",
        data: {},
      });
      expect((await pending).body).not.toContain("db-failed-frame");
      await vi.waitFor(() => expect(data.dispose).toHaveBeenCalledTimes(1));
      expect(data.dispose).toHaveBeenCalledTimes(1);
      expect(data.listeners.size).toBe(0);
    } finally {
      await data.close();
    }
  });

  it.each(["浏览器会话过期", "认证查库故障"])(
    "%s时真实Controller发送队列不等待自身释放，preClose确认关闭",
    async (failure) => {
      const data = await fixture(true, true);
      try {
        const pending = data.inject();
        await data.ready;
        if (failure === "浏览器会话过期") data.advance(60_000);
        else
          vi.spyOn(data.service, "authenticate").mockRejectedValue(
            new Error("认证数据库不可用"),
          );
        // 原Controller实际产生帧，并在dispose内等待自己的sending队列。
        const subscribing = data.controller().call("subscribeControllerV4", {
          topic: protocol.CONTROLLER_TASKS_INDEX_TOPIC,
          visibility: "foreground",
        });
        await Promise.allSettled([subscribing]);
        await vi.waitFor(() => expect(data.dispose).toHaveBeenCalledTimes(1));
        await data.app.close();
        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('"event":"ready"');
        expect(response.body).not.toContain("onDynamicControllerFrame");
        expect(data.reply()?.raw.writableEnded).toBe(true);
        expect(data.listeners.size).toBe(0);
        expect(data.disposeSource).toHaveBeenCalledTimes(1);
        expect(data.closeConnections).toHaveBeenCalledTimes(1);
        expect(data.deliveryFailed).not.toHaveBeenCalled();
        expect(() =>
          data.connections.require(
            data.instanceId,
            data.getConnectionId(),
            false,
          ),
        ).toThrow("已关闭");
      } finally {
        await data.close();
      }
    },
  );

  it("preClose释放真实Controller订阅及回环HTTP的SSE后才完成", async () => {
    const data = await fixture(false, true);
    try {
      const address = await data.app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${address}/api/code-ui/events`, {
        headers: data.headers,
      });
      expect(response.status).toBe(200);
      const pending = response.text();
      await data.ready;
      expect(
        await data.controller().call("subscribeControllerV4", {
          topic: protocol.CONTROLLER_TASKS_INDEX_TOPIC,
          visibility: "foreground",
        }),
      ).toMatchObject({ result: { ack: { mode: "snapshot" } } });
      await vi.waitFor(() =>
        expect(data.reply()?.raw.write).toHaveBeenCalledWith(
          expect.stringContaining("onDynamicControllerFrame"),
        ),
      );
      await data.app.close();
      expect(await pending).toContain("onDynamicControllerFrame");
      expect(data.reply()?.raw.writableEnded).toBe(true);
      expect(data.listeners.size).toBe(0);
      expect(data.dispose).toHaveBeenCalledTimes(1);
      expect(data.disposeSource).toHaveBeenCalledTimes(1);
      expect(data.closeConnections).toHaveBeenCalledTimes(1);
      expect(data.deliveryFailed).not.toHaveBeenCalled();
    } finally {
      await data.close();
    }
  });
});
