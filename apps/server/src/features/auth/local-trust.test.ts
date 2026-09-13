import { describe, expect, it } from "vitest";

import {
  assertLocalTrustPosture,
  createLocalTrustAuthenticator,
  isLoopbackHostname,
  isTrustedOrigin,
  LOCAL_TRUST_EMAIL,
} from "./local-trust.js";

const LOCAL_IP = "127.0.0.1";

function createAccounts(options: { fail?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      async ensurePasswordlessAccount(input: { email: string }) {
        calls.push(input.email);
        if (options.fail) {
          throw new Error("db down");
        }
        return { email: input.email, id: "local-user-1" };
      },
    },
  };
}

describe("local-trust：来源判定", () => {
  it("回环主机名判定覆盖 IPv4/IPv6 字面量与 localhost", () => {
    for (const host of [
      "127.0.0.1",
      "::1",
      "[::1]",
      "localhost",
      "LOCALHOST",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
    for (const host of ["0.0.0.0", "192.168.1.5", "10.0.0.1", "example.com"]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });

  it("Origin 判定：无来源放行、回环放行、其它网页与 null 一律拒绝", () => {
    expect(isTrustedOrigin(undefined)).toBe(true);
    expect(isTrustedOrigin("http://127.0.0.1:3001")).toBe(true);
    expect(isTrustedOrigin("http://localhost:3000")).toBe(true);
    expect(isTrustedOrigin("http://[::1]:3001")).toBe(true);

    // 用户浏览器里的任意网页都能发起这种请求（CORS 只挡读响应），必须拒绝
    expect(isTrustedOrigin("https://evil.example.com")).toBe(false);
    // 沙箱 iframe / file:// 都会给出 null，恶意页面同样能造出来
    expect(isTrustedOrigin("null")).toBe(false);
    expect(isTrustedOrigin("not-a-url")).toBe(false);
  });
});

describe("local-trust：认证", () => {
  it("无 Origin + 回环 IP → 本机用户，且账号只解析一次（进程内缓存）", async () => {
    const { calls, provider } = createAccounts();
    const authenticator = createLocalTrustAuthenticator({ accounts: provider });

    const first = await authenticator.authenticate({
      headers: {},
      ip: LOCAL_IP,
    });
    const second = await authenticator.authenticate({
      headers: { origin: "http://127.0.0.1:3001" },
      ip: "::1",
    });

    expect(first).toEqual({
      // 本形态没有会话令牌：空串明确表达「无凭据可转发」
      accessToken: "",
      email: LOCAL_TRUST_EMAIL,
      id: "local-user-1",
      userMetadata: { display_name: "本机用户", local_trust: true },
    });
    expect(second?.id).toBe("local-user-1");
    expect(calls).toEqual([LOCAL_TRUST_EMAIL]);
  });

  it("非回环 IP → 拒绝且不碰数据库（防误配置对外暴露后免登录）", async () => {
    const { calls, provider } = createAccounts();
    const authenticator = createLocalTrustAuthenticator({ accounts: provider });

    expect(
      await authenticator.authenticate({ headers: {}, ip: "192.168.1.5" }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("非回环来源页面 → 拒绝（防用户浏览器里的网页读本机数据）", async () => {
    const { calls, provider } = createAccounts();
    const authenticator = createLocalTrustAuthenticator({ accounts: provider });

    expect(
      await authenticator.authenticate({
        headers: { origin: "https://evil.example.com" },
        ip: LOCAL_IP,
      }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("数据层故障折叠为未认证（路由回 401，不泄漏内部细节）", async () => {
    const { provider } = createAccounts({ fail: true });
    const authenticator = createLocalTrustAuthenticator({ accounts: provider });

    expect(
      await authenticator.authenticate({ headers: {}, ip: LOCAL_IP }),
    ).toBeNull();
  });
});

describe("local-trust：启动期姿态校验", () => {
  it("免登录形态绑非回环地址 → 拒绝启动（局域网内人人都是本机用户）", () => {
    expect(() =>
      assertLocalTrustPosture({ authDriver: "local-trust", host: "0.0.0.0" }),
    ).toThrow(/只能绑定回环地址/);
  });

  it("回环地址与自管形态放行", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(() =>
        assertLocalTrustPosture({ authDriver: "local-trust", host }),
      ).not.toThrow();
    }
    expect(() =>
      assertLocalTrustPosture({ authDriver: "managed", host: "0.0.0.0" }),
    ).not.toThrow();
    // 未设置认证形态（默认 managed）同样放行
    expect(() =>
      assertLocalTrustPosture({ authDriver: undefined, host: "0.0.0.0" }),
    ).not.toThrow();
  });
});
