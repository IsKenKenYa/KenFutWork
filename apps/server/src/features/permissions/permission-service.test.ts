import { describe, expect, it } from "vitest";

import {
  createPermissionService,
  isDangerousTool,
} from "./permission-service.js";

describe("permissions 缝（DEC-4）", () => {
  it("不带调用绑定的 once 不再假装授权成功", () => {
    const service = createPermissionService();
    expect(() => service.approve("Write", { scope: "once" })).toThrow(/绑定/);
    expect(service.evaluate({ toolName: "Write" }).decision).toBe("deny");
  });

  it("真实 Code 写入与命令工具在 default 档等待审批", () => {
    const service = createPermissionService();
    for (const toolName of ["Write", "Edit", "ApplyPatch", "Bash"]) {
      expect(service.evaluate({ toolName }).decision, toolName).toBe("deny");
    }
  });

  it("安全工具在任意档位直接放行", () => {
    const svc = createPermissionService();
    expect(svc.evaluate({ toolName: "preview_file" }).decision).toBe("allow");
    expect(svc.evaluate({ toolName: "inspect_canvas" }).decision).toBe("allow");
  });

  it("default 档：危险工具未审批即拒绝（含理由）", () => {
    const svc = createPermissionService();
    const decision = svc.evaluate({ toolName: "mcp__fs__write" });
    expect(decision.decision).toBe("deny");
    // 理由必须说清**去哪批准**（模型据此转述给用户，含糊会让它编出「审批弹窗」）
    expect(decision.reason).toMatch(/设置 → 权限 → 工具审批/);
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

  it("永久批准随 applySettings 恢复、随 getSettings 读出（重启持久化的内存侧契约）", () => {
    // 启动期读回：持久化里带着上次的永久批准，服务一建好就生效
    const restored = createPermissionService();
    restored.applySettings({
      tier: "default",
      automationTier: "default",
      rules: { allow: [], deny: [] },
      approvedForever: ["execute", "mcp__py__run"],
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      browserDevtoolsReadEnabled: true,
      browserEvalEnabled: false,
    });
    expect(restored.listApprovedForever()).toEqual([
      "execute",
      "mcp__py__run",
    ]);
    expect(restored.evaluate({ toolName: "execute" }).decision).toBe("allow");

    // 读回后再增补：getSettings 里的 approvedForever 同步增长（写穿存储的数据源）
    restored.approve("write_file", { scope: "forever" });
    expect(restored.getSettings().approvedForever).toEqual([
      "execute",
      "mcp__py__run",
      "write_file",
    ]);
    expect(restored.evaluate({ toolName: "write_file" }).decision).toBe(
      "allow",
    );

    // PUT tier 的合并路径：getSettings() 展开再 applySettings，批准清单不丢
    const merged = { ...restored.getSettings(), tier: "auto-approve" as const };
    restored.applySettings(merged);
    expect(restored.listApprovedForever()).toEqual([
      "execute",
      "mcp__py__run",
      "write_file",
    ]);
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
 * R5-3：第 4 档「自定义」与分场景档位（常规 / 自动化）。
 * 规则判定顺序固定为 **deny → allow → default 兜底**，且这几条是安全边界，逐条锁死。
 */
describe("permissions 缝（R5-3 自定义档与分场景）", () => {
  it("custom 档：拒绝项命中即拒（拒绝优先于放行），放行项命中即放", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "custom",
      automationTier: "default",
      rules: {
        allow: ["write_file", "mcp__py-helper__echo"],
        deny: ["mcp__py-helper__add"],
      },
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      approvedForever: [],
      browserDevtoolsReadEnabled: false,
      browserEvalEnabled: false,
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
      browserAutoScreenshot: false,
      browserHeadless: false,
      approvedForever: [],
      browserDevtoolsReadEnabled: false,
      browserEvalEnabled: false,
    });
    expect(svc.evaluate({ toolName: "mcp__fs__write" }).decision).toBe("deny");
    expect(svc.evaluate({ toolName: "mcp__py-helper__echo" }).decision).toBe(
      "deny",
    );
    // 普通工具不受这条规则影响（execute 仍走 default 的审批要求）
    expect(svc.evaluate({ toolName: "execute" }).reason).toMatch(
      /设置 → 权限 → 工具审批/,
    );
  });

  it("分场景：自动化任务（目标/循环）用 automationTier，不受常规档影响", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "full-access",
      automationTier: "default",
      rules: { allow: [], deny: [] },
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      approvedForever: [],
      browserDevtoolsReadEnabled: false,
      browserEvalEnabled: false,
    });
    // 常规：全放行
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "interactive" })
        .decision,
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
      browserAutoScreenshot: false,
      browserHeadless: false,
      approvedForever: [],
      browserDevtoolsReadEnabled: false,
      browserEvalEnabled: false,
    });
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "automation" }).decision,
    ).toBe("allow");
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "interactive" })
        .decision,
    ).toBe("deny");
  });

  it("线程显式设过的档位优先于场景档（会话级覆盖）", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "default",
      automationTier: "default",
      rules: { allow: [], deny: [] },
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      approvedForever: [],
      browserDevtoolsReadEnabled: false,
      browserEvalEnabled: false,
    });
    svc.setTier("t1", "full-access");
    expect(
      svc.evaluate({
        toolName: "execute",
        threadId: "t1",
        scenario: "automation",
      }).decision,
    ).toBe("allow");
  });
});
