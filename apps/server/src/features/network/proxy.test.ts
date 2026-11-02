import { Agent, EnvHttpProxyAgent } from "undici";
import { describe, expect, it } from "vitest";

import {
  buildNetworkProxyDispatcher,
  hasNetworkProxyConfig,
  installNetworkProxy,
  resolveNetworkProxyConfig,
} from "./proxy.js";

describe("网络出口偏好", () => {
  it("空串视为未配置，只认合法字段", () => {
    expect(
      resolveNetworkProxyConfig({
        httpProxy: "  ",
        httpProxyNoProxy: "",
        httpProxyCaCertPath: "",
      }),
    ).toEqual({});
    expect(
      resolveNetworkProxyConfig({
        httpProxy: " http://127.0.0.1:7890 ",
        httpProxyNoProxy: "*.local, api.example.com",
        httpProxyCaCertPath: "/etc/ssl/private/ca.pem",
      }),
    ).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      noProxy: "*.local, api.example.com",
      caCertPath: "/etc/ssl/private/ca.pem",
    });
  });

  it("相对 CA 路径启动期直接报错，不用猜测基准目录", () => {
    expect(() =>
      resolveNetworkProxyConfig({ httpProxyCaCertPath: "ca.pem" }),
    ).toThrow("必须是绝对路径");
  });

  it("有代理时用 EnvHttpProxyAgent（支持 No Proxy），只有 CA 时用普通 Agent", async () => {
    expect(hasNetworkProxyConfig({})).toBe(false);
    expect(hasNetworkProxyConfig({ httpProxy: "http://127.0.0.1:1" })).toBe(
      true,
    );
    const proxied = await buildNetworkProxyDispatcher({
      httpProxy: "http://127.0.0.1:7890",
      noProxy: "localhost",
    });
    expect(proxied.dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    expect(proxied.summary).toEqual({
      proxy: "http://127.0.0.1:7890",
      hasNoProxy: true,
      usesCaCertificate: false,
    });
    const caOnly = await buildNetworkProxyDispatcher(
      { caCertPath: "/ca.pem" },
      async () => Buffer.from("certificate"),
    );
    expect(caOnly.dispatcher).toBeInstanceOf(Agent);
    expect(caOnly.summary.usesCaCertificate).toBe(true);
  });

  it("没有配置时不动全局 dispatcher；有配置才安装并返回摘要", async () => {
    const installed: unknown[] = [];
    expect(
      await installNetworkProxy({
        preferences: {},
        install: (dispatcher) => installed.push(dispatcher),
      }),
    ).toBeNull();
    expect(installed).toHaveLength(0);

    const summary = await installNetworkProxy({
      preferences: { httpProxy: "http://127.0.0.1:7890" },
      install: (dispatcher) => installed.push(dispatcher),
    });
    expect(summary).toMatchObject({ proxy: "http://127.0.0.1:7890" });
    expect(installed[0]).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("CA 文件读取失败向上抛，不静默跳过代理配置", async () => {
    await expect(
      buildNetworkProxyDispatcher({ caCertPath: "/missing.pem" }, async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toThrow("ENOENT");
  });
});
