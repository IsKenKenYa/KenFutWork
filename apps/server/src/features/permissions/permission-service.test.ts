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
    expect(isDangerousTool("file_write")).toBe(true);
    expect(isDangerousTool("diff_files")).toBe(false);
    expect(isDangerousTool("generate_image")).toBe(false);
  });
});
