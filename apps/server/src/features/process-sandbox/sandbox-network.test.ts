import { describe, expect, it } from "vitest";

import { sandboxNetworkFor } from "./plugin.js";

/**
 * 沙箱网络名单来自权限策略的域名规则（设置 → 权限 → 网络安全）。
 *
 * 沙箱默认 `strictAllowlist: true`：白名单为空 = 全部出站被拦。所以映射错一位
 * 就会出现「允许了却连不上」或「拒绝了却连得上」，而这两种都只能在真实命令里
 * 才暴露——这里把映射锁死。
 */
describe("沙箱网络名单（域名规则 → allowed/denied）", () => {
  it("allow 规则进白名单，deny 规则进黑名单", () => {
    const network = sandboxNetworkFor([
      { domain: "api.example.com", action: "allow" },
      { domain: "*.internal.example", action: "deny" },
    ]);
    expect(network.allowedDomains).toEqual(["api.example.com"]);
    expect(network.deniedDomains).toEqual(["*.internal.example"]);
  });

  it("ask 规则不进任何名单（沙箱层不表达「问一下」）", () => {
    const network = sandboxNetworkFor([
      { domain: "prompt.example.com", action: "ask" },
    ]);
    // ask 由工具门审批处理；沙箱不能弹审批，因此既不白也不黑
    expect(network.allowedDomains).toEqual([]);
    expect(network.deniedDomains).toEqual([]);
  });

  it("空规则 → 两个空名单（等于全部出站被拦，与改造前一致）", () => {
    expect(sandboxNetworkFor([])).toEqual({
      allowedDomains: [],
      deniedDomains: [],
    });
  });

  it("同一个域名既 allow 又 deny 时两处都在（黑名单优先由沙箱裁决）", () => {
    const network = sandboxNetworkFor([
      { domain: "example.com", action: "allow" },
      { domain: "example.com", action: "deny" },
    ]);
    expect(network.allowedDomains).toEqual(["example.com"]);
    expect(network.deniedDomains).toEqual(["example.com"]);
  });

  it("保留规则顺序（沙箱按名单匹配，不依赖顺序，但界面展示要稳定）", () => {
    const network = sandboxNetworkFor([
      { domain: "b.example.com", action: "allow" },
      { domain: "a.example.com", action: "allow" },
    ]);
    expect(network.allowedDomains).toEqual(["b.example.com", "a.example.com"]);
  });
});
