import type { ExecutionMode } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_EXECUTION_MODES,
  createExecutionModeService,
  evaluateToolPolicy,
  isPlanApprovalInput,
  isPlanApprovalMessage,
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
      return true;
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

  it("hydrate：带store时按当前Scope读回模式并warm缓存，无行回落agent", async () => {
    const store = makeFakeStore();
    const service = createExecutionModeService({ store });
    store.rows.set("t-persisted", { exists: true, mode: "plan" });

    expect(await service.hydrate("t-persisted", { workspaceId: "ws" })).toBe(
      "plan",
    );
    // warm 后 getMode 直接命中
    expect(service.getMode("t-persisted")).toBe("plan");

    // 无行 → agent，不借另一工作区可能存在的热缓存
    expect(await service.hydrate("t-missing", { workspaceId: "ws" })).toBe(
      "agent",
    );

    // 当前持久事实改变时，hydrate必须读回，不能保留旧alias负缓存
    store.rows.set("t-missing", { exists: true, mode: "solo" });
    expect(await service.hydrate("t-missing", { workspaceId: "ws" })).toBe(
      "solo",
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
  it("plan 使用真实 Code 只读工具名，可信只读 Bash 由审批门再逐次确认", () => {
    const service = createExecutionModeService();
    service.activate("code-plan", "plan");
    const policy = service.resolveToolPolicy("code-plan");
    for (const tool of ["Read", "Glob", "Grep", "TaskOutput"]) {
      expect(evaluateToolPolicy(policy, tool).allowed, tool).toBe(true);
    }
    expect(
      evaluateToolPolicy(policy, "Bash", { readonlyExecution: true }).allowed,
    ).toBe(true);
    expect(evaluateToolPolicy(policy, "Bash").allowed).toBe(false);
    expect(
      evaluateToolPolicy(policy, "execute", { readonlyExecution: true })
        .allowed,
    ).toBe(false);
  });

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

describe("plan 批准门（isPlanApprovalMessage，机器可读批准）", () => {
  it("整句批准短语命中：中英文、句末标点、大小写、首尾空白", () => {
    for (const text of [
      "批准",
      "批准！",
      "批准。",
      "  批准  ",
      "同意执行",
      "开始执行",
      "按计划执行",
      "就这么办",
      "没问题。",
      "可以",
      "OK",
      "ok!",
      "Approved.",
      "LGTM",
      "go ahead",
    ]) {
      expect(isPlanApprovalMessage(text), JSON.stringify(text)).toBe(true);
    }
  });

  it("含批准词但带额外内容的不算（误升档比多切一次档危险）", () => {
    for (const text of [
      "批准这个方案，不过第三步先改改",
      "不批准",
      "先不批准，我再想想",
      "同意，但是换一个文件名",
      "批准了，另外帮我看看测试",
      "什么时候开始执行？",
      "我要开始执行我的计划了",
    ]) {
      expect(isPlanApprovalMessage(text), JSON.stringify(text)).toBe(false);
    }
  });

  it("空串/超长/普通对话不命中", () => {
    expect(isPlanApprovalMessage("")).toBe(false);
    expect(isPlanApprovalMessage("   ")).toBe(false);
    expect(
      isPlanApprovalMessage("这个方案看起来非常周密，辛苦你了，请继续保持"),
    ).toBe(false);
    expect(isPlanApprovalMessage("帮我写个爬虫")).toBe(false);
  });
});

describe("plan 批准门对组合 prompt 的判定（isPlanApprovalInput）", () => {
  const HISTORY_BLOCK =
    "【对话历史（供参考，延续上文语境）】\n用户：创建文件\n助手：好的，这是计划\n\n【本轮用户消息】\n";

  it("workbench 组合 prompt：本轮消息（末行）是批准短语即命中", () => {
    expect(isPlanApprovalInput(`${HISTORY_BLOCK}批准`)).toBe(true);
    expect(isPlanApprovalInput(`${HISTORY_BLOCK}批准！`)).toBe(true);
    expect(isPlanApprovalInput("批准")).toBe(true);
  });

  it("组合 prompt 本轮消息带额外内容不命中", () => {
    expect(isPlanApprovalInput(`${HISTORY_BLOCK}批准，但先改第三步`)).toBe(
      false,
    );
    expect(isPlanApprovalInput(`${HISTORY_BLOCK}不批准`)).toBe(false);
  });

  it("历史里出现批准字样不误判（只看末行）", () => {
    const tricky =
      "【对话历史（供参考，延续上文语境）】\n用户：批准了吗\n助手：等待批准\n\n【本轮用户消息】\n先等等，我再看看";
    expect(isPlanApprovalInput(tricky)).toBe(false);
  });
});

describe("plan 只读子代理白名单（DEC-17：派发按定义只读性放行）", () => {
  function planPolicy() {
    const service = createExecutionModeService();
    service.activate("t-plan-sub", "plan");
    return service.resolveToolPolicy("t-plan-sub");
  }

  it("subagent_task/subagent_background 携带只读定义 detail 时放行（explore/review/planner 可派）", () => {
    const policy = planPolicy();
    for (const tool of ["subagent_task", "subagent_background"]) {
      expect(
        evaluateToolPolicy(policy, tool, { subagentReadOnly: true }).allowed,
        tool,
      ).toBe(true);
    }
  });

  it("subagent_task 携带可写定义或不带 detail 时仍拒绝（batch_image/video_generate 不可派）", () => {
    const policy = planPolicy();
    expect(
      evaluateToolPolicy(policy, "subagent_task", {
        subagentReadOnly: false,
      }).allowed,
    ).toBe(false);
    expect(evaluateToolPolicy(policy, "subagent_task").allowed).toBe(false);
    expect(
      evaluateToolPolicy(policy, "subagent_background", {
        subagentReadOnly: false,
      }).allowed,
    ).toBe(false);
  });

  it("task_output 无条件只读放行；solo 下派发一律拒绝", () => {
    expect(evaluateToolPolicy(planPolicy(), "task_output").allowed).toBe(true);
    const service = createExecutionModeService();
    service.activate("t-solo-sub", "solo");
    const solo = service.resolveToolPolicy("t-solo-sub");
    expect(
      evaluateToolPolicy(solo, "task", { subagentReadOnly: true }).allowed,
    ).toBe(false);
    expect(evaluateToolPolicy(solo, "task_output").allowed).toBe(false);
  });
});
