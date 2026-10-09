import { describe, expect, it } from "vitest";

import { isLocalAccessExempt } from "./plugin.js";

/**
 * 本机接入总门的放行判定：除健康检查/一次性连接入口外，**机器对机器路由**
 * （flow 网关回调，自带共享密钥门）在路由配置里声明 `skipLocalAccess` 放行；
 * 其余 /api 路由依旧要求本机凭据。
 */
describe("本机接入总门放行判定", () => {
  const request = (
    method: string,
    url: string,
    routeConfig?: unknown,
  ): Parameters<typeof isLocalAccessExempt>[0] => ({
    method,
    url,
    routeConfig,
  });

  it("健康检查和一次性连接入口永远放行（预检 OPTIONS 与非 /api 路径亦然）", () => {
    expect(isLocalAccessExempt(request("GET", "/api/health"))).toBe(true);
    expect(
      isLocalAccessExempt(request("POST", "/api/local-access/connect")),
    ).toBe(true);
    expect(isLocalAccessExempt(request("OPTIONS", "/api/anything"))).toBe(true);
    expect(isLocalAccessExempt(request("GET", "/favicon.ico"))).toBe(true);
  });

  it("声明 skipLocalAccess 的路由放行（只认 true，字符串/false 不算）", () => {
    expect(
      isLocalAccessExempt(
        request("POST", "/api/flow/host/identity", { skipLocalAccess: true }),
      ),
    ).toBe(true);
    expect(
      isLocalAccessExempt(
        request("POST", "/api/flow/host/credentials", {
          skipLocalAccess: true,
          other: 1,
        }),
      ),
    ).toBe(true);
    expect(
      isLocalAccessExempt(
        request("POST", "/api/flow/host/events", { skipLocalAccess: false }),
      ),
    ).toBe(false);
    expect(
      isLocalAccessExempt(
        request("POST", "/api/flow/host/events", { skipLocalAccess: "true" }),
      ),
    ).toBe(false);
  });

  it("普通 /api 路由仍要求本机凭据（默认不放行）", () => {
    expect(isLocalAccessExempt(request("GET", "/api/projects"))).toBe(false);
    expect(
      isLocalAccessExempt(request("POST", "/api/flow/host/identity-ticket")),
    ).toBe(false);
    expect(
      isLocalAccessExempt(request("GET", "/api/flow/host/status", undefined)),
    ).toBe(false);
  });
});
