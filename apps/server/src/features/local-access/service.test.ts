import { describe, expect, it, vi } from "vitest";

import {
  createLocalAccessService,
  hashLocalAccessToken,
  isLoopbackAddress,
} from "./service.js";
import { createLocalAccessFixture } from "./test-fixture.js";
import { LocalAccessError } from "./types.js";

describe("本机接入服务", () => {
  it("撤权监听器抛错不阻断其它监听，凭据已经失效且失败原因可读", async () => {
    const fixture = await createLocalAccessFixture();
    try {
      const issued = await fixture.service.createApiClient(fixture.request, {
        label: "撤权通知",
      });
      const notified: string[] = [];
      fixture.service.onRevoked(() => {
        throw new Error("监听关闭失败");
      });
      fixture.service.onRevoked(async () => {
        throw new Error("异步监听关闭失败");
      });
      fixture.service.onRevoked((id) => {
        notified.push(id);
      });
      await expect(
        fixture.service.revokeClient(fixture.request, issued.client.id),
      ).rejects.toMatchObject({
        code: "local_access_unavailable",
        statusCode: 503,
        message: "接入凭据已撤销，部分连接关闭尚未确认，请重试撤销。",
      });
      expect(notified).toEqual([issued.client.id]);
      expect(
        await fixture.service.authenticate({
          ip: "127.0.0.1",
          headers: { authorization: `Bearer ${issued.token}` },
        }),
      ).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
  it("并发初始化与重启沿用同一桌面凭据，actor不含秘密或账户字段", async () => {
    const fixture = await createLocalAccessFixture();
    try {
      const restarted = createLocalAccessService(fixture.options);
      await Promise.all([restarted.initialize(), restarted.initialize()]);
      expect(await restarted.getDesktopToken()).toBe(fixture.token);
      expect(fixture.clients.size).toBe(1);
      const actor = await restarted.authenticate(fixture.request);
      expect(actor).toEqual({
        instanceId: fixture.instanceId,
        accessClientId: [...fixture.clients.keys()][0],
      });
      expect(JSON.stringify(actor)).not.toContain(fixture.token);
      expect([...fixture.clients.values()][0]?.tokenHash).toBe(
        hashLocalAccessToken(fixture.token),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("仅接受真实回环socket，包括IPv4映射IPv6", () => {
    for (const ip of [
      "127.0.0.1",
      "127.0.0.2",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackAddress(ip)).toBe(true);
    }
    for (const ip of [
      undefined,
      "localhost",
      "192.168.1.2",
      "::ffff:192.168.1.2",
      "::",
      "127.invalid",
    ]) {
      expect(isLoopbackAddress(ip)).toBe(false);
    }
  });

  it("缺失、伪造、冲突与重复凭据不能回落到其它认证方式", async () => {
    const fixture = await createLocalAccessFixture();
    try {
      const cookie = `kfw_local_access=${fixture.token}`;
      for (const headers of [
        {},
        { authorization: "Bearer wrong" },
        { authorization: `Bearer ${fixture.token}`, cookie },
        { authorization: "invalid", cookie },
        {
          authorization: `Bearer ${fixture.token}`,
          cookie: "kfw_local_access",
        },
        { cookie: `${cookie}; ${cookie}` },
        { cookie: "kfw_local_access=" },
      ]) {
        expect(
          await fixture.service.authenticate({ ip: "127.0.0.1", headers }),
        ).toBeNull();
      }
      expect(
        await fixture.service.authenticate({
          ip: "127.0.0.1",
          headers: { cookie },
        }),
      ).toEqual(await fixture.service.authenticate(fixture.request));
    } finally {
      await fixture.cleanup();
    }
  });

  it("精确Origin校验拒绝null、相同主机其它端口、非回环IP与伪造转发头", async () => {
    const fixture = await createLocalAccessFixture();
    try {
      for (const origin of [
        "null",
        "",
        "http://127.0.0.1:4000",
        "http://localhost:3000/path",
        "https://evil.test",
      ]) {
        expect(
          await fixture.service.authenticate({
            ...fixture.request,
            headers: { ...fixture.request.headers, origin },
          }),
        ).toBeNull();
      }
      expect(
        await fixture.service.authenticate({
          ...fixture.request,
          headers: {
            ...fixture.request.headers,
            origin: "http://localhost:3000",
          },
        }),
      ).toEqual(await fixture.service.authenticate(fixture.request));
      expect(
        await fixture.service.authenticate({
          ...fixture.request,
          ip: "192.168.1.2",
          headers: {
            ...fixture.request.headers,
            "x-forwarded-for": "127.0.0.1",
          },
        }),
      ).toBeNull();
      expect(
        await fixture.service.authenticate({
          headers: fixture.request.headers,
        }),
      ).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("票据并发消费first-wins且不可重放；只返回HttpOnly cookie", async () => {
    const fixture = await createLocalAccessFixture();
    try {
      const { ticket } = await fixture.service.issueTicket(fixture.request);
      const results = await Promise.allSettled([
        fixture.service.consumeTicket(
          { ip: "127.0.0.1", headers: {} },
          { ticket },
        ),
        fixture.service.consumeTicket(
          { ip: "127.0.0.1", headers: {} },
          { ticket },
        ),
      ]);
      const succeeded = results.filter(
        (result) => result.status === "fulfilled",
      );
      expect(succeeded).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      if (succeeded[0]?.status !== "fulfilled") throw new Error("连接没有成功");
      const connected = succeeded[0].value;
      expect(connected.cookie).toContain(
        "HttpOnly; SameSite=Strict; Path=/; Max-Age=60",
      );
      expect(Object.keys(connected)).toEqual(["actor", "client", "cookie"]);
      expect(Object.keys(connected.client)).not.toContain("tokenHash");
      expect(fixture.clients.size).toBe(2);
      await expect(
        fixture.service.consumeTicket(
          { ip: "127.0.0.1", headers: {} },
          { ticket },
        ),
      ).rejects.toMatchObject({ code: "local_access_invalid_ticket" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("连接入口同样拒绝冲突和重复cookie，拒绝时不消耗有效票据", async () => {
    const fixture = await createLocalAccessFixture();
    try {
      const ticket = await fixture.service.issueTicket(fixture.request);
      const cookie = `kfw_local_access=${fixture.token}`;
      for (const headers of [
        { cookie, ...fixture.request.headers },
        { cookie: `${cookie}; ${cookie}` },
        { authorization: "invalid" },
      ]) {
        await expect(
          fixture.service.consumeTicket({ ip: "127.0.0.1", headers }, ticket),
        ).rejects.toMatchObject({ code: "unauthorized" });
      }
      expect(
        (
          await fixture.service.consumeTicket(
            { ip: "127.0.0.1", headers: {} },
            ticket,
          )
        ).client.kind,
      ).toBe("browser");
    } finally {
      await fixture.cleanup();
    }
  });

  it("票据与浏览器会话分别按治理值过期，过期票据不创建记录", async () => {
    const fixture = await createLocalAccessFixture();
    try {
      const expired = await fixture.service.issueTicket(fixture.request);
      fixture.advance(5_000);
      await expect(
        fixture.service.consumeTicket(
          { ip: "127.0.0.1", headers: {} },
          expired,
        ),
      ).rejects.toMatchObject({ code: "local_access_invalid_ticket" });
      expect(fixture.clients.size).toBe(1);
      const fresh = await fixture.service.issueTicket(fixture.request);
      const connected = await fixture.service.consumeTicket(
        { ip: "127.0.0.1", headers: {} },
        fresh,
      );
      const request = {
        ip: "127.0.0.1",
        headers: { cookie: connected.cookie.split(";")[0] },
      };
      expect(await fixture.service.authenticate(request)).toEqual(
        connected.actor,
      );
      fixture.advance(60_000);
      expect(await fixture.service.authenticate(request)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("脚本凭据可访问实例但不能委托；撤销立即生效且幂等", async () => {
    const fixture = await createLocalAccessFixture();
    try {
      const issued = await fixture.service.createApiClient(fixture.request, {
        label: "脚本",
      });
      const request = {
        ip: "127.0.0.1",
        headers: { authorization: `Bearer ${issued.token}` },
      };
      expect(await fixture.service.authenticate(request)).toEqual({
        instanceId: fixture.instanceId,
        accessClientId: issued.client.id,
      });
      for (const action of [
        () => fixture.service.issueTicket(request),
        () => fixture.service.createApiClient(request, { label: "委托" }),
        () => fixture.service.listClients(request),
        () => fixture.service.revokeClient(request, issued.client.id),
      ])
        await expect(action()).rejects.toMatchObject({ code: "forbidden" });
      const clients = await fixture.service.listClients(fixture.request);
      expect(JSON.stringify(clients)).not.toContain(issued.token);
      expect(JSON.stringify(clients)).not.toContain("tokenHash");
      await fixture.service.revokeClient(fixture.request, issued.client.id);
      await fixture.service.revokeClient(fixture.request, issued.client.id);
      expect(await fixture.service.authenticate(request)).toBeNull();
      const desktopId = (await fixture.service.authenticate(fixture.request))
        ?.accessClientId;
      if (!desktopId) throw new Error("桌面接入缺失");
      await expect(
        fixture.service.revokeClient(fixture.request, desktopId),
      ).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("签发客户端撤销后，未消费票据失效；并发mint不能越过Store授权检查", async () => {
    const fixture = await createLocalAccessFixture();
    try {
      const ticket = await fixture.service.issueTicket(fixture.request);
      const browser = await fixture.service.consumeTicket(
        { ip: "127.0.0.1", headers: {} },
        ticket,
      );
      const browserRequest = {
        ip: "127.0.0.1",
        headers: { cookie: browser.cookie.split(";")[0] },
      };
      const pendingTicket = await fixture.service.issueTicket(browserRequest);
      let resume!: () => void;
      let entered!: () => void;
      const enteredCreate = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      fixture.pauseCreate(async () => {
        entered();
        await blocked;
      });
      const pendingMint = fixture.service.createApiClient(browserRequest, {
        label: "不能落库",
      });
      const assertion =
        expect(pendingMint).rejects.toBeInstanceOf(LocalAccessError);
      await enteredCreate;
      await fixture.service.revokeClient(fixture.request, browser.client.id);
      resume();
      await assertion;
      fixture.pauseCreate(undefined);
      await expect(
        fixture.service.consumeTicket(
          { ip: "127.0.0.1", headers: {} },
          pendingTicket,
        ),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(
        [...fixture.clients.values()].map((client) => client.label),
      ).not.toContain("不能落库");
      expect(
        (
          await fixture.service.createApiClient(fixture.request, {
            label: "其它客户端",
          })
        ).client.kind,
      ).toBe("api");
    } finally {
      await fixture.cleanup();
    }
  });

  it("数据库异常原样向调用方传播，不能折叠成未认证", async () => {
    const fixture = await createLocalAccessFixture();
    try {
      const failure = new Error("数据库不可用");
      vi.spyOn(fixture.store, "findActiveByTokenHash").mockRejectedValue(
        failure,
      );
      await expect(fixture.service.authenticate(fixture.request)).rejects.toBe(
        failure,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
