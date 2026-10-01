import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "../../kernel/types.js";
import { createUnavailableExecutor } from "./executor.js";
import { createComputerUseService } from "./service.js";
import { CU_TOOL_PREFIX, createComputerUseTools } from "./tools.js";

const governance = () => ({
  actionTimeoutMs: 10_000,
  observeMaxBytes: 32_768,
  screenshotMaxBytes: 262_144,
  maxActionsPerRun: 200,
  sessionMaxMs: 1_800_000,
});

function buildTools(gate: { ok: boolean; message?: string }) {
  const service = createComputerUseService({
    executor: createUnavailableExecutor("平台不支持"),
    governance,
  });
  return createComputerUseTools({ service, gate: async () => gate });
}

describe("createComputerUseTools（工具面装配）", () => {
  it("8 个工具全部 mcp__computer-use__ 前缀 + scope:code", () => {
    const tools = buildTools({ ok: true });
    expect(tools).toHaveLength(8);
    for (const tool of tools) {
      expect(tool.name.startsWith(CU_TOOL_PREFIX)).toBe(true);
      expect(tool.scope).toBe("code");
      expect(tool.description.length).toBeGreaterThan(10);
    }
    expect(tools.map((t) => t.name)).toEqual([
      "mcp__computer-use__request_access",
      "mcp__computer-use__list_apps",
      "mcp__computer-use__list_windows",
      "mcp__computer-use__get_app_state",
      "mcp__computer-use__screenshot",
      "mcp__computer-use__click",
      "mcp__computer-use__type",
      "mcp__computer-use__stop_computer_control",
    ]);
  });

  it("门控关闭（未安装/停用）→ 拒绝并指路（plugin_disabled）", async () => {
    const tools = buildTools({
      ok: false,
      message: "Computer Use 插件未安装：请在工作台「插件市场」安装后重试。",
    });
    const listApps = tools.find((t) => t.name.endsWith("list_apps"))!;
    const result = (await listApps.execute({}, { runId: "r1" })) as {
      isError?: boolean;
      structuredContent?: { error?: { code?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error?.code).toBe("plugin_disabled");
  });

  it("门控通过但执行器不可用 → 显式 unavailable（fail loud，不冒充成功）", async () => {
    const tools = buildTools({ ok: true });
    const state = tools.find((t) => t.name.endsWith("get_app_state"))!;
    const result = (await state.execute(
      { app: "com.apple.calculator" },
      { runId: "r1" },
    )) as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error?.code).toBe("unavailable");
  });

  it("工具面是纯装配：ToolDefinition 形状可被 kernel 桥接消费", () => {
    const tools: ToolDefinition[] = buildTools({ ok: true });
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: "object" });
      expect(typeof tool.execute).toBe("function");
    }
  });
});
