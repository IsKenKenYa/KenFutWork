import { expect, it } from "vitest";
import { toolAllowedForRun } from "./runtime.js";

it("未声明清单时不限制工具", () => {
  expect(toolAllowedForRun({}, "Bash")).toBe(true);
});

it("白名单只放行列出的工具，交集与黑名单同时生效", () => {
  const run = {
    toolAllowlist: ["Read", "Grep", "Bash"],
    toolDenylist: ["Bash"],
  };
  expect(toolAllowedForRun(run, "Read")).toBe(true);
  expect(toolAllowedForRun(run, "Grep")).toBe(true);
  expect(toolAllowedForRun(run, "Bash")).toBe(false);
  expect(toolAllowedForRun(run, "Write")).toBe(false);
});

it("只有黑名单时其余工具不受影响", () => {
  expect(toolAllowedForRun({ toolDenylist: ["Bash"] }, "Read")).toBe(true);
  expect(toolAllowedForRun({ toolDenylist: ["Bash"] }, "Bash")).toBe(false);
});
