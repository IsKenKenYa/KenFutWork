import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import Fastify, { type FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerInstanceRoutes } from "../../http/instance.js";
import { createLocalAccessFixture } from "../local-access/test-fixture.js";
import {
  createDataLocationController,
  type DataLocationBridge,
  registerDataLocationControl,
} from "./data-control.js";
import { createLocalInstanceService } from "./service.js";

async function fixture(bridge?: DataLocationBridge) {
  const access = await createLocalAccessFixture();
  const instance = createLocalInstanceService({
    repository: { ensure: async () => access.instanceId },
    dataDir: access.dataDir,
  });
  const target = `${access.dataDir}-target`;
  const controller = createDataLocationController({
    localInstance: instance,
    localAccess: access.service,
    pointerFile: join(`${access.dataDir}-config`, "data-location.json"),
  });
  const unregister = bridge
    ? registerDataLocationControl(instance, bridge)
    : () => {};
  const app = Fastify();
  await registerInstanceRoutes(app, {
    localAccess: access.service,
    localInstance: instance,
    dataControl: controller,
  });
  return {
    ...access,
    app,
    instance,
    target,
    controller,
    unregister,
    async close() {
      unregister();
      await app.close();
      await access.cleanup();
      await rm(target, { recursive: true, force: true });
    },
  };
}

function bridge() {
  return {
    canMove: true,
    waitUntilIdle: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

describe("本机数据目录HTTP控制", () => {
  it("缺凭据拒绝；未注册生命周期桥仅可查看且明确不可移动", async () => {
    const data = await fixture();
    try {
      expect(
        (
          await data.app.inject({
            method: "GET",
            url: "/api/instance/data-location",
          })
        ).statusCode,
      ).toBe(401);
      const location = await data.app.inject({
        method: "GET",
        url: "/api/instance/data-location",
        headers: data.request.headers,
      });
      expect(location.json()).toEqual({
        dataDir: data.dataDir,
        canMove: false,
      });
      const prepare = await data.app.inject({
        method: "POST",
        url: "/api/instance/data-location/prepare",
        headers: data.request.headers,
        payload: { dataDir: data.target },
      });
      expect(prepare.statusCode).toBe(503);
      expect(data.instance.isDraining()).toBe(false);
    } finally {
      await data.close();
    }
  });

  it("浏览器可查看位置；browser/api不能准备或停机，撤销浏览器后拒绝查看", async () => {
    const host = bridge();
    const data = await fixture(host);
    try {
      const ticket = await data.service.issueTicket(data.request);
      const browser = await data.service.consumeTicket(
        { ip: "127.0.0.1", headers: {} },
        ticket,
      );
      const cookie = browser.cookie.split(";")[0] ?? "";
      const script = await data.service.createApiClient(data.request, {
        label: "脚本",
      });
      for (const headers of [
        { cookie },
        { authorization: `Bearer ${script.token}` },
      ]) {
        expect(
          (
            await data.app.inject({
              method: "GET",
              url: "/api/instance/data-location",
              headers,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await data.app.inject({
              method: "POST",
              url: "/api/instance/data-location/prepare",
              headers,
              payload: { dataDir: data.target },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await data.app.inject({
              method: "POST",
              url: "/api/instance/data-location/shutdown",
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(403);
      }
      await data.service.revokeClient(data.request, browser.client.id);
      expect(
        (
          await data.app.inject({
            method: "GET",
            url: "/api/instance/data-location",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(401);
      expect(host.waitUntilIdle).not.toHaveBeenCalled();
      expect(host.shutdown).not.toHaveBeenCalled();
    } finally {
      await data.close();
    }
  });

  it("非法目录与body覆盖归属在进入维护态前拒绝", async () => {
    const host = bridge();
    const data = await fixture(host);
    try {
      await mkdir(data.target);
      await writeFile(join(data.target, "keep"), "不得覆盖");
      for (const payload of [
        { dataDir: data.target },
        { dataDir: data.dataDir },
        { dataDir: "relative" },
        { dataDir: data.target, instanceId: data.instanceId },
      ]) {
        const response = await data.app.inject({
          method: "POST",
          url: "/api/instance/data-location/prepare",
          headers: data.request.headers,
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(host.waitUntilIdle).not.toHaveBeenCalled();
      expect(data.instance.isDraining()).toBe(false);
    } finally {
      await data.close();
    }
  });

  it("prepare真实等待idle，期间禁止新工作，ready后才允许单次停机且响应先完成", async () => {
    let release!: () => void;
    let entered!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const host = bridge();
    host.waitUntilIdle.mockImplementation(async () => {
      entered();
      await idle;
    });
    const data = await fixture(host);
    let response: FastifyReply | undefined;
    data.app.addHook("onRequest", async (request, reply) => {
      if (request.url.endsWith("/shutdown")) response = reply;
    });
    host.shutdown.mockImplementation(async () => {
      expect(response?.raw.writableFinished).toBe(true);
    });
    try {
      const premature = await data.app.inject({
        method: "POST",
        url: "/api/instance/data-location/shutdown",
        headers: data.request.headers,
        payload: {},
      });
      expect(premature.statusCode).toBe(503);
      const pending = data.app
        .inject({
          method: "POST",
          url: "/api/instance/data-location/prepare",
          headers: data.request.headers,
          payload: { dataDir: data.target },
        })
        .then((value) => value);
      await waiting;
      expect(data.instance.isDraining()).toBe(true);
      expect(() => data.instance.assertReady()).toThrow("暂不接收新任务");
      expect(host.shutdown).not.toHaveBeenCalled();
      release();
      expect((await pending).json()).toEqual({ ready: true });
      const accepted = await data.app.inject({
        method: "POST",
        url: "/api/instance/data-location/shutdown",
        headers: data.request.headers,
        payload: {},
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toEqual({ accepted: true });
      await vi.waitFor(() => expect(host.shutdown).toHaveBeenCalledTimes(1));
      const repeated = await data.app.inject({
        method: "POST",
        url: "/api/instance/data-location/shutdown",
        headers: data.request.headers,
        payload: {},
      });
      expect(repeated.statusCode).toBe(503);
      expect(host.shutdown).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await data.close();
    }
  });

  it("等待失败和停机失败都解除维护态，返回503后仍能重新准备", async () => {
    const host = bridge();
    host.waitUntilIdle.mockRejectedValueOnce(new Error("真实等待失败"));
    host.shutdown.mockRejectedValueOnce(new Error("停库失败"));
    const data = await fixture(host);
    try {
      const failed = await data.app.inject({
        method: "POST",
        url: "/api/instance/data-location/prepare",
        headers: data.request.headers,
        payload: { dataDir: data.target },
      });
      expect(failed.statusCode).toBe(503);
      expect(data.instance.isDraining()).toBe(false);
      expect(() => data.instance.assertReady()).not.toThrow();
      const ready = await data.app.inject({
        method: "POST",
        url: "/api/instance/data-location/prepare",
        headers: data.request.headers,
        payload: { dataDir: data.target },
      });
      expect(ready.statusCode).toBe(200);
      const accepted = await data.app.inject({
        method: "POST",
        url: "/api/instance/data-location/shutdown",
        headers: data.request.headers,
        payload: {},
      });
      expect(accepted.statusCode).toBe(202);
      await vi.waitFor(() => expect(data.instance.isDraining()).toBe(false));
      expect(
        (
          await data.app.inject({
            method: "POST",
            url: "/api/instance/data-location/prepare",
            headers: data.request.headers,
            payload: { dataDir: data.target },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await data.close();
    }
  });

  it("取消旧等待不会解除后续维护", async () => {
    const host = bridge();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    host.waitUntilIdle.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const data = await fixture(host);
    try {
      const abort = new AbortController();
      const old = data.controller.prepare(
        data.request,
        { dataDir: data.target },
        abort.signal,
      );
      const rejected = expect(old).rejects.toMatchObject({ statusCode: 503 });
      await waiting;
      abort.abort();
      await rejected;
      expect(data.instance.isDraining()).toBe(false);
      expect(
        await data.controller.prepare(data.request, { dataDir: data.target }),
      ).toEqual({ ready: true });
      release();
      await setImmediate();
      expect(data.instance.isDraining()).toBe(true);
    } finally {
      release?.();
      await data.close();
    }
  });

  it("等待期间桌面凭据被撤销不返回ready，并解除维护态", async () => {
    const host = bridge();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    host.waitUntilIdle.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const data = await fixture(host);
    try {
      const pending = data.app
        .inject({
          method: "POST",
          url: "/api/instance/data-location/prepare",
          headers: data.request.headers,
          payload: { dataDir: data.target },
        })
        .then((response) => response);
      await waiting;
      const actor = await data.service.authenticate(data.request);
      const client = actor?.accessClientId
        ? data.clients.get(actor.accessClientId)
        : undefined;
      if (!client) throw new Error("没有真实桌面客户端。");
      client.revokedAt = new Date().toISOString();
      release();
      expect((await pending).statusCode).toBe(401);
      expect(data.instance.isDraining()).toBe(false);
      expect(host.shutdown).not.toHaveBeenCalled();
    } finally {
      release?.();
      await data.close();
    }
  });

  it("外部数据库bridge明确拒绝管理", async () => {
    const host = bridge();
    host.canMove = false;
    const data = await fixture(host);
    try {
      expect(
        (
          await data.app.inject({
            method: "GET",
            url: "/api/instance/data-location",
            headers: data.request.headers,
          })
        ).json().canMove,
      ).toBe(false);
      expect(
        (
          await data.app.inject({
            method: "POST",
            url: "/api/instance/data-location/prepare",
            headers: data.request.headers,
            payload: { dataDir: data.target },
          })
        ).statusCode,
      ).toBe(403);
      expect(host.waitUntilIdle).not.toHaveBeenCalled();
    } finally {
      await data.close();
    }
  });
});
