import { describe, expect, it } from "vitest";

import { resolveSandboxMode } from "./service.js";

/**
 * 沙箱安全总开关：关掉之后，「完全访问」档也拿不到 `danger-full-access`。
 *
 * 这条是安全边界：`danger-full-access` 意味着命令不受授权目录与网络白名单约束。
 * 有些用户希望把权限档位拉到最高、但仍要求命令留在沙箱边界内——那个组合就靠这里成立。
 */
describe("沙箱安全总开关（执行模式 → 沙箱模式）", () => {
  it("开关打开（缺省）：yolo 拿 danger-full-access", () => {
    expect(
      resolveSandboxMode({
        mode: "yolo",
        fallback: "workspace-write",
        sandboxEnabled: true,
      }),
    ).toBe("danger-full-access");
  });

  it("开关关闭：yolo 降级为 workspace-write，拿不到不隔离", () => {
    expect(
      resolveSandboxMode({
        mode: "yolo",
        fallback: "workspace-write",
        sandboxEnabled: false,
      }),
    ).toBe("workspace-write");
  });

  it("非 yolo 模式不受开关影响（本来就按调用方的 fallback 走）", () => {
    for (const mode of ["default", "plan", "build", "read-only"]) {
      expect(
        resolveSandboxMode({
          mode,
          fallback: "workspace-write",
          sandboxEnabled: true,
        }),
        mode,
      ).toBe("workspace-write");
      expect(
        resolveSandboxMode({
          mode,
          fallback: "read-only",
          sandboxEnabled: false,
        }),
        mode,
      ).toBe("read-only");
    }
  });
});
