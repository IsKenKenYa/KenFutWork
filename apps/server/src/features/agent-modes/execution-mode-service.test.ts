import type { ExecutionMode } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_EXECUTION_MODES,
  createExecutionModeService,
  evaluateToolPolicy,
} from "./execution-mode-service.js";
import type { ExecutionModeStore } from "./execution-mode-store.js";

function makeFakeStore(): ExecutionModeStore & {
  saved: Array<{ workspaceId: string; threadId: string; mode: string }>;
  rows: Map<string, { exists: boolean; mode: ExecutionMode | null }>;
} {
  const saved: Array<{ workspaceId: string; threadId: string; mode: string }> =
    [];
  const rows = new Map<
    string,
    { exists: boolean; mode: ExecutionMode | null }
  >();
  return {
    saved,
    rows,
    async lookup(workspaceId, threadId) {
      void workspaceId;
      return rows.get(threadId) ?? { exists: false, mode: null };
    },
    async save(workspaceId, threadId, mode) {
      saved.push({ workspaceId, threadId, mode });
      rows.set(threadId, { exists: true, mode });
    },
  };
}

describe("执行模式词汇表", () => {
  it("六档内置：agent/plan/solo/goal/loop/creative，creative 有创造引导指令", () => {
    const ids = BUILTIN_EXECUTION_MODES.map((m) => m.id);
    expect(ids).toEqual(["agent", "plan", "solo", "goal", "loop", "creative"]);
    const creative = BUILTIN_EXECUTION_MODES.find((m) => m.id === "creative");
    expect(creative?.inputDirective).toContain("SKILL.md");
  });

  it("activate 未知模式 fail loud；getMode 未激活返回 agent", async () => {
    const service = createExecutionModeService();
    expect(service.getMode("t1")).toBe("agent");
    await service.activate("t1", "plan");
    expect(service.getMode("t1")).toBe("plan");
    await expect(service.activate("t1", "auto" as never)).rejects.toThrow(
      /未知执行模式/,
    );
  });

  it("activate 带 scope 写穿 store；无 scope 时纯内存（不触碰 store）", async () => {
    const store = makeFakeStore();
    const service = createExecutionModeService({ store });

    await service.activate("t-w", "goal", { workspaceId: "ws-1" });
    expect(store.saved).toEqual([
      { workspaceId: "ws-1", threadId: "t-w", mode: "goal" },
    ]);

    await service.activate("t-m", "loop");
    expect(store.saved).toHaveLength(1);
    expect(service.getMode("t-m")).toBe("loop");
  });

  it("hydrate：缓存命中不查库；miss 时读回持久化模式并 warm 缓存；无行回落 agent", async () => {
    const store = makeFakeStore();
    const service = createExecutionModeService({ store });
    store.rows.set("t-persisted", { exists: true, mode: "plan" });

    expect(await service.hydrate("t-persisted", { workspaceId: "ws" })).toBe(
      "plan",
    );
    // warm 后 getMode 直接命中
    expect(service.getMode("t-persisted")).toBe("plan");

    // 无行/未设置 → agent，同样进缓存
    expect(await service.hydrate("t-missing", { workspaceId: "ws" })).toBe(
      "agent",
    );

    // 缓存命中：改库不再影响读数（activate 才会刷新缓存）
    store.rows.set("t-missing", { exists: true, mode: "solo" });
    expect(await service.hydrate("t-missing", { workspaceId: "ws" })).toBe(
      "agent",
    );
  });

  it("hydrate/lookup 无 store 时退化为内存语义（部分装配兼容）", async () => {
    const service = createExecutionModeService();
    expect(await service.hydrate("t-x", { workspaceId: "ws" })).toBe("agent");
    // hydrate 会把回落值 warm 进缓存：无 store 的 lookup 只报缓存值，exists 恒 false
    expect(await service.lookup("t-x", { workspaceId: "ws" })).toEqual({
      exists: false,
      mode: "agent",
    });
    await service.activate("t-x", "solo");
    expect(await service.lookup("t-x", { workspaceId: "ws" })).toEqual({
      exists: false,
      mode: "solo",
    });
  });

  it("lookup：行存在返回 exists+mode，行不存在/未设置为 null", async () => {
    const store = makeFakeStore();
    const service = createExecutionModeService({ store });
    store.rows.set("t-set", { exists: true, mode: "creative" });
    store.rows.set("t-unset", { exists: true, mode: null });

    expect(await service.lookup("t-set", { workspaceId: "ws" })).toEqual({
      exists: true,
      mode: "creative",
    });
    expect(await service.lookup("t-unset", { workspaceId: "ws" })).toEqual({
      exists: true,
      mode: null,
    });
    expect(await service.lookup("t-none", { workspaceId: "ws" })).toEqual({
      exists: false,
      mode: null,
    });
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
