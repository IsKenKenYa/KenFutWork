import { describe, expect, it } from "vitest";

import {
  BUILTIN_EXECUTION_MODES,
  createExecutionModeService,
  evaluateToolPolicy,
} from "./execution-mode-service.js";

describe("执行模式词汇表", () => {
  it("六档内置：agent/plan/solo/goal/loop/creative，creative 有创造引导指令", () => {
    const ids = BUILTIN_EXECUTION_MODES.map((m) => m.id);
    expect(ids).toEqual([
      "agent",
      "plan",
      "solo",
      "goal",
      "loop",
      "creative",
    ]);
    const creative = BUILTIN_EXECUTION_MODES.find((m) => m.id === "creative");
    expect(creative?.inputDirective).toContain("SKILL.md");
  });

  it("activate 未知模式 fail loud；getMode 未激活返回 agent", () => {
    const service = createExecutionModeService();
    expect(service.getMode("t1")).toBe("agent");
    service.activate("t1", "plan");
    expect(service.getMode("t1")).toBe("plan");
    expect(() => service.activate("t1", "auto" as never)).toThrow(/未知执行模式/);
  });
});

describe("模式工具策略（evaluateToolPolicy）", () => {
  it("solo：deny-all，任何工具（含只读与 deepagents 内置）一律拒绝", () => {
    const service = createExecutionModeService();
    service.activate("t-solo", "solo");
    const policy = service.resolveToolPolicy("t-solo");
    expect(policy.kind).toBe("deny-all");
    for (const tool of ["web_search", "read_file", "write_todos", "execute"]) {
      const verdict = evaluateToolPolicy(policy, tool);
      expect(verdict.allowed, tool).toBe(false);
    }
  });

  it("plan：read-only 白名单放行只读工具，拒绝修改/执行/外部调用", () => {
    const service = createExecutionModeService();
    service.activate("t-plan", "plan");
    const policy = service.resolveToolPolicy("t-plan");
    expect(policy.kind).toBe("read-only");
    // 白名单放行：deepagents 内置只读 + 内核只读工具
    for (const tool of [
      "ls",
      "read_file",
      "glob",
      "grep",
      "write_todos",
      "web_search",
      "list_skills",
      "inspect_canvas",
    ]) {
      expect(evaluateToolPolicy(policy, tool).allowed, tool).toBe(true);
    }
    // 修改/执行/子代理/MCP/生成一律拒绝
    for (const tool of [
      "write_file",
      "edit_file",
      "execute",
      "task",
      "delete",
      "mcp__weather__get",
      "image_generate",
      "video_generate",
      "manipulate_canvas",
      "persist_sandbox_file",
    ]) {
      const verdict = evaluateToolPolicy(policy, tool);
      expect(verdict.allowed, tool).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.reason).toContain("plan");
      }
    }
  });

  it("agent/goal/loop/creative：allow-all，工具不拦截", () => {
    const service = createExecutionModeService();
    for (const mode of ["agent", "goal", "loop", "creative"] as const) {
      service.activate(`t-${mode}`, mode);
      const policy = service.resolveToolPolicy(`t-${mode}`);
      expect(policy.kind, mode).toBe("allow-all");
      expect(evaluateToolPolicy(policy, "write_file").allowed).toBe(true);
      expect(evaluateToolPolicy(policy, "execute").allowed).toBe(true);
    }
  });
});
