import { describe, expect, it } from "vitest";
import {
  EMPTY_PERMISSION_POLICY,
  matchesPermissionDomain,
  permissionDomainRuleSchema,
  permissionPolicySchema,
} from "./capability-contracts.js";

/**
 * 网络安全：域名三态规则的匹配口径（参考 WorkBuddy 安全中心）。
 *
 * 这一层是纯函数，服务端出口（`fetchPageSnapshot`）与设置界面共用同一份匹配：
 * 口径写错会让「我明明拒绝了 example.com 却还能打开」这类问题静默发生，
 * 所以边界逐条锁死。
 */
describe("域名规则匹配（网络安全）", () => {
  it("裸域名命中本身与全部子域", () => {
    expect(matchesPermissionDomain("example.com", "example.com")).toBe(true);
    expect(matchesPermissionDomain("example.com", "www.example.com")).toBe(
      true,
    );
    expect(matchesPermissionDomain("example.com", "a.b.example.com")).toBe(
      true,
    );
  });

  it("`*.` 写法只吃子域，不含裸域名本身", () => {
    expect(matchesPermissionDomain("*.example.com", "www.example.com")).toBe(
      true,
    );
    expect(matchesPermissionDomain("*.example.com", "example.com")).toBe(false);
  });

  it("前缀相同但不是同一域名不命中", () => {
    // 这是最容易写错的一类：`notexample.com` 与 `example.com` 前缀相同
    expect(matchesPermissionDomain("example.com", "notexample.com")).toBe(
      false,
    );
    expect(matchesPermissionDomain("example.com", "example.com.evil")).toBe(
      false,
    );
  });

  it("大小写不敏感", () => {
    expect(matchesPermissionDomain("Example.COM", "WWW.example.com")).toBe(
      true,
    );
  });

  it("带端口的规则只匹配该端口", () => {
    expect(
      matchesPermissionDomain("example.com:8080", "example.com", "8080"),
    ).toBe(true);
    expect(
      matchesPermissionDomain("example.com:8080", "example.com", "9090"),
    ).toBe(false);
    expect(matchesPermissionDomain("example.com:8080", "example.com", "")).toBe(
      false,
    );
    // 不带端口的规则匹配任意端口
    expect(matchesPermissionDomain("example.com", "example.com", "9090")).toBe(
      true,
    );
  });

  it("空值不命中（防止空规则拦下所有请求）", () => {
    expect(matchesPermissionDomain("", "example.com")).toBe(false);
    expect(matchesPermissionDomain("example.com", "")).toBe(false);
  });
});

describe("域名规则契约", () => {
  it("缺省策略带空域名表，旧数据解析后不丢其它字段", () => {
    const parsed = permissionPolicySchema.parse({
      rules: [{ pattern: "mcp__*", action: "deny" }],
      disabledTools: ["shell_*"],
      pathRules: [{ path: "/protected", action: "deny" }],
    });
    expect(parsed.domainRules).toEqual([]);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.pathRules).toHaveLength(1);
    expect(EMPTY_PERMISSION_POLICY.domainRules).toEqual([]);
  });

  it("域名规则不清洗成别名：只收 domain + action", () => {
    expect(
      permissionDomainRuleSchema.safeParse({
        domain: "example.com",
        action: "ask",
      }).success,
    ).toBe(true);
    // 多余键被 strict 拦下（界面误传 url 之类的字段不能静默进库）
    expect(
      permissionDomainRuleSchema.safeParse({
        domain: "example.com",
        action: "ask",
        url: "https://example.com",
      }).success,
    ).toBe(false);
  });
});
