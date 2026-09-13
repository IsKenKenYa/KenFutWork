import { describe, expect, it } from "vitest";

import { composeToolGate } from "./tool-gate.js";

/**
 * 回归：权限档必须能拦住 **deepagents 内置工具**。
 *
 * 背景（实测）：内置 `execute` / `write_file` 不经过 `ctx.tools.execute`，
 * `tool-pre-execute` 事件缝对它们不触发；若权限只在事件缝上生效，
 * 默认「需审批」档下 agent 可以不经放行直接执行 shell 命令。
 */
describe("composeToolGate", () => {
  const allowAllMode = () => ({ allowed: true }) as const;

  it("模式拒绝优先于权限判定（理由来自模式）", () => {
    const gate = composeToolGate({
      modeVerdict: () => ({ allowed: false, reason: "solo 禁用工具" }),
      permissionVerdict: () => ({ allowed: true }),
    });
    expect(gate("read_file")).toEqual({
      allowed: false,
      reason: "solo 禁用工具",
    });
  });

  it("模式放行但权限拒绝 → 拒绝（覆盖内置 execute）", () => {
    const gate = composeToolGate({
      modeVerdict: allowAllMode,
      permissionVerdict: (name) =>
        name === "execute"
          ? { allowed: false, reason: "危险操作需审批" }
          : { allowed: true },
    });
    expect(gate("execute")).toEqual({
      allowed: false,
      reason: "危险操作需审批",
    });
  });

  it("权限维度未挂载时退化为只看模式", () => {
    const gate = composeToolGate({ modeVerdict: allowAllMode });
    expect(gate("execute")).toEqual({ allowed: true });
  });

  it("两个维度都放行才放行", () => {
    const gate = composeToolGate({
      modeVerdict: allowAllMode,
      permissionVerdict: () => ({ allowed: true }),
    });
    expect(gate("read_file")).toEqual({ allowed: true });
  });

  it("权限判定返回 undefined 视为该维度不表态", () => {
    const gate = composeToolGate({
      modeVerdict: allowAllMode,
      permissionVerdict: () => undefined,
    });
    expect(gate("execute")).toEqual({ allowed: true });
  });
});
