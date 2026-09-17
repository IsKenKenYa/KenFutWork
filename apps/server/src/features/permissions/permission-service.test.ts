import { describe, expect, it } from "vitest";

import {
  createPermissionService,
  isDangerousTool,
} from "./permission-service.js";

describe("permissions 缝（DEC-4）", () => {
  it("安全工具在任意档位直接放行", () => {
    const svc = createPermissionService();
    expect(svc.evaluate({ toolName: "preview_file" }).decision).toBe("allow");
    expect(svc.evaluate({ toolName: "inspect_canvas" }).decision).toBe("allow");
  });

  it("default 档：危险工具未审批即拒绝（含理由）", () => {
    const svc = createPermissionService();
    const decision = svc.evaluate({ toolName: "mcp__fs__write" });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toMatch(/等待用户审批/);
  });

  it("永久审批记忆放行；thread 记忆只影响该会话", () => {
    const svc = createPermissionService();
    svc.approve("mcp__fs__write", { scope: "thread", threadId: "t1" });
    expect(
      svc.evaluate({ toolName: "mcp__fs__write", threadId: "t1" }).decision,
    ).toBe("allow");
    expect(
      svc.evaluate({ toolName: "mcp__fs__write", threadId: "t2" }).decision,
    ).toBe("deny");
    svc.approve("execute", { scope: "forever" });
    expect(svc.evaluate({ toolName: "execute" }).decision).toBe("allow");
    expect(svc.listApprovedForever()).toEqual(["execute"]);
  });

  it("auto-approve 档自动放行危险工具；full-access 全放行；线程档位覆盖全局", () => {
    const svc = createPermissionService();
    svc.setTier(undefined, "auto-approve");
    expect(svc.evaluate({ toolName: "execute" }).decision).toBe("allow");
    svc.setTier("t1", "default");
    expect(svc.getTier("t1")).toBe("default");
    expect(svc.evaluate({ toolName: "execute", threadId: "t1" }).decision).toBe(
      "deny",
    );
    svc.setTier("t1", "full-access");
    expect(svc.evaluate({ toolName: "execute", threadId: "t1" }).decision).toBe(
      "allow",
    );
  });

  it("isDangerousTool 覆盖 shell/MCP/写类模式", () => {
    expect(isDangerousTool("LocalShell_execute")).toBe(true);
    expect(isDangerousTool("mcp__anything")).toBe(true);
    expect(isDangerousTool("execute")).toBe(true);
    expect(isDangerousTool("diff_patch")).toBe(true);
    expect(isDangerousTool("diff_files")).toBe(false);
    expect(isDangerousTool("generate_image")).toBe(false);
  });

  /**
   * 回归：模式表必须匹配**真实注册名**。
   * 曾经写成 `/^file_write$/`（错拼），而 deepagents 内置工具真实名是 `write_file`——
   * 于是默认档下「写文件需审批」静默失效，而当时的用例恰好也用了同一个错拼名，双双漏过。
   */
  it("deepagents 内置写工具按真实名进入审批（回归）", () => {
    expect(isDangerousTool("write_file")).toBe(true);
    expect(isDangerousTool("edit_file")).toBe(true);
  });
});

/**
 * R5-3：第 4 档「自定义配置」与分场景档位（常规 / 自动化）。
 * 规则判定顺序固定为 **deny → allow → default 兜底**，且这几条是安全边界，逐条锁死。
 */
describe("permissions 缝（R5-3 自定义配置与分场景）", () => {
  it("custom 档：拒绝项命中即拒（拒绝优先于放行），放行项命中即放", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "custom",
      automationTier: "default",
      rules: { allow: ["write_file", "mcp__py-helper__echo"], deny: ["mcp__py-helper__add"] },
      browserControlEnabled: false,
    });
    // 放行项：危险工具（write_file）也放行
    expect(svc.evaluate({ toolName: "write_file" }).decision).toBe("allow");
    // 拒绝项：即便同一个前缀也被拒
    const denied = svc.evaluate({ toolName: "mcp__py-helper__add" });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toMatch(/自定义规则/);
    // 都没命中 → 回落 default：危险工具要审批
    expect(svc.evaluate({ toolName: "execute" }).decision).toBe("deny");
    // 安全工具照旧放行
    expect(svc.evaluate({ toolName: "preview_file" }).decision).toBe("allow");
  });

  it("通配：`mcp__*` 命中所有 MCP 工具，但不命中普通工具", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "custom",
      automationTier: "default",
      rules: { allow: [], deny: ["mcp__*"] },
      browserControlEnabled: false,
    });
    expect(svc.evaluate({ toolName: "mcp__fs__write" }).decision).toBe("deny");
    expect(svc.evaluate({ toolName: "mcp__py-helper__echo" }).decision).toBe("deny");
    // 普通工具不受这条规则影响（execute 仍走 default 的审批要求）
    expect(svc.evaluate({ toolName: "execute" }).reason).toMatch(/等待用户审批/);
  });

  it("分场景：自动化任务（目标/循环）用 automationTier，不受常规档影响", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "full-access",
      automationTier: "default",
      rules: { allow: [], deny: [] },
      browserControlEnabled: false,
    });
    // 常规：全放行
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "interactive" }).decision,
    ).toBe("allow");
    // 自动化：仍按 default 要求审批（无人值守时更严）
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "automation" }).decision,
    ).toBe("deny");
    // 反过来：自动化放开、常规收紧，同样各按各的
    svc.applySettings({
      tier: "default",
      automationTier: "auto-approve",
      rules: { allow: [], deny: [] },
      browserControlEnabled: false,
    });
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "automation" }).decision,
    ).toBe("allow");
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "interactive" }).decision,
    ).toBe("deny");
  });

  it("线程显式设过的档位优先于场景档（会话级覆盖）", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "default",
      automationTier: "default",
      rules: { allow: [], deny: [] },
      browserControlEnabled: false,
    });
    svc.setTier("t1", "full-access");
    expect(
      svc.evaluate({ toolName: "execute", threadId: "t1", scenario: "automation" })
        .decision,
    ).toBe("allow");
  });
});
