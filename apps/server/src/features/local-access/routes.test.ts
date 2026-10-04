import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerLocalAccessRoutes } from "./routes.js";
import { createLocalAccessFixture } from "./test-fixture.js";

async function setup() {
  const fixture = await createLocalAccessFixture();
  const app = Fastify();
  await registerLocalAccessRoutes(app, { localAccessService: fixture.service });
  return {
    ...fixture,
    app,
    close: async () => {
      await app.close();
      await fixture.cleanup();
    },
  };
}

describe("本机接入HTTP路由", () => {
  it("缺凭据和未知Origin返回中文401，不信任转发头", async () => {
    const fixture = await setup();
    try {
      for (const input of [
        {},
        { headers: { ...fixture.request.headers, origin: "null" } },
        {
          headers: {
            ...fixture.request.headers,
            origin: "http://localhost:4999",
          },
        },
        {
          headers: {
            ...fixture.request.headers,
            "x-forwarded-for": "127.0.0.1",
          },
          remoteAddress: "192.168.1.5",
        },
      ]) {
        const response = await fixture.app.inject({
          method: "GET",
          url: "/api/local-access/clients",
          ...input,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().error).toEqual({
          code: "unauthorized",
          message: "本机连接凭据缺失、已失效，或请求来源不受信任。",
        });
      }
    } finally {
      await fixture.close();
    }
  });

  it("ticket连接仅Set-Cookie；后续cookie访问与桌面访问同一实例", async () => {
    const fixture = await setup();
    try {
      const ticketResponse = await fixture.app.inject({
        method: "POST",
        url: "/api/local-access/tickets",
        headers: fixture.request.headers,
        payload: {},
      });
      expect(ticketResponse.statusCode).toBe(201);
      const connected = await fixture.app.inject({
        method: "POST",
        url: "/api/local-access/connect",
        headers: { origin: "http://localhost:3000" },
        payload: { ticket: ticketResponse.json().ticket, label: "我的浏览器" },
      });
      expect(connected.statusCode).toBe(200);
      expect(connected.json().instanceId).toBe(fixture.instanceId);
      expect(connected.json().client.label).toBe("我的浏览器");
      expect(connected.json()).not.toHaveProperty("token");
      expect(connected.headers["set-cookie"]).toContain("HttpOnly");
      expect(connected.headers["cache-control"]).toBe("no-store");
      const cookieHeader = connected.headers["set-cookie"];
      if (typeof cookieHeader !== "string")
        throw new Error("未获得浏览器cookie");
      const cookie = cookieHeader.split(";")[0] ?? "";
      const list = await fixture.app.inject({
        method: "GET",
        url: "/api/local-access/clients",
        headers: { cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().clients).toHaveLength(2);
      const conflict = await fixture.app.inject({
        method: "GET",
        url: "/api/local-access/clients",
        headers: { cookie, ...fixture.request.headers },
      });
      expect(conflict.statusCode).toBe(401);
      const replay = await fixture.app.inject({
        method: "POST",
        url: "/api/local-access/connect",
        payload: { ticket: ticketResponse.json().ticket },
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe("local_access_invalid_ticket");
    } finally {
      await fixture.close();
    }
  });

  it("脚本令牌仅签发一次；列表不泄漏秘密，撤销后立刻拒绝访问", async () => {
    const fixture = await setup();
    try {
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/local-access/clients",
        headers: fixture.request.headers,
        payload: { label: "自动化脚本" },
      });
      expect(created.statusCode).toBe(201);
      const { token, client } = created.json();
      const list = await fixture.app.inject({
        method: "GET",
        url: "/api/local-access/clients",
        headers: fixture.request.headers,
      });
      expect(list.body).not.toContain(token);
      expect(list.body).not.toContain("token_hash");
      const deniedMint = await fixture.app.inject({
        method: "POST",
        url: "/api/local-access/tickets",
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(deniedMint.statusCode).toBe(403);
      const deleted = await fixture.app.inject({
        method: "DELETE",
        url: `/api/local-access/clients/${client.id}`,
        headers: fixture.request.headers,
      });
      expect(deleted.statusCode).toBe(204);
      expect(
        await fixture.service.authenticate({
          ip: "127.0.0.1",
          headers: { authorization: `Bearer ${token}` },
        }),
      ).toBeNull();
      const repeated = await fixture.app.inject({
        method: "DELETE",
        url: `/api/local-access/clients/${client.id}`,
        headers: fixture.request.headers,
      });
      expect(repeated.statusCode).toBe(204);
    } finally {
      await fixture.close();
    }
  });

  it("拒绝请求覆盖instance归属，数据库故障返回503而非401", async () => {
    const fixture = await setup();
    try {
      const malformed = await fixture.app.inject({
        method: "POST",
        url: "/api/local-access/clients",
        headers: fixture.request.headers,
        payload: { label: "脚本", instanceId: fixture.instanceId },
      });
      expect(malformed.statusCode).toBe(400);
      vi.spyOn(fixture.store, "findActiveByTokenHash").mockRejectedValue(
        new Error("数据库不可用"),
      );
      const failed = await fixture.app.inject({
        method: "GET",
        url: "/api/local-access/clients",
        headers: fixture.request.headers,
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error.code).toBe("local_access_unavailable");
      expect(failed.body).not.toContain(fixture.token);
    } finally {
      await fixture.close();
    }
  });
});
