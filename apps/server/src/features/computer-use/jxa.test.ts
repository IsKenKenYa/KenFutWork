import { describe, expect, it } from "vitest";

import { normalizeAxNode, normalizeRole, toJxaAppSelector } from "./jxa.js";

describe("normalizeRole（AX role → kind）", () => {
  it("常见 role 映射为短名", () => {
    expect(normalizeRole("AXButton")).toBe("button");
    expect(normalizeRole("AXStaticText")).toBe("text");
    expect(normalizeRole("AXScrollArea")).toBe("scrollarea");
  });

  it("未知 role 去前缀小写，缺省为 unknown", () => {
    expect(normalizeRole("AXSomethingNew")).toBe("somethingnew");
    expect(normalizeRole(undefined)).toBe("unknown");
  });
});

describe("normalizeAxNode（JXA 原始元素 → AxNode）", () => {
  it("role/title/value/states 传递，children 递归", () => {
    const node = normalizeAxNode({
      role: "AXButton",
      title: "7",
      states: ["pressable"],
      children: [{ role: "AXStaticText", title: "七" }],
    });
    expect(node).toMatchObject({
      role: "button",
      title: "7",
      states: ["pressable"],
      children: [{ role: "text", title: "七" }],
    });
  });

  it("空对象与无身份子节点被剔除（与动作脚本过滤谓词一致）", () => {
    const node = normalizeAxNode({
      role: "AXGroup",
      children: [{}, { role: "AXButton", title: "ok" }],
    });
    expect(node.children).toHaveLength(1);
    expect(node.children?.[0]?.role).toBe("button");
  });

  it("value 非字符串被字符串化", () => {
    const node = normalizeAxNode({ role: "AXSlider", value: 42 });
    expect(node.value).toBe("42");
  });
});

describe("toJxaAppSelector（应用定位脚本）", () => {
  it("pid 优先走 unixId 精确定位", () => {
    expect(toJxaAppSelector({ pid: 123 })).toBe(
      "se.applicationProcesses.whose({unixId: 123})[0]",
    );
  });

  it("bundleId 走 bundleIdentifier；name 走 byName；引号转义", () => {
    expect(toJxaAppSelector({ bundleId: "com.apple.calculator" })).toContain(
      'bundleIdentifier: "com.apple.calculator"',
    );
    expect(toJxaAppSelector({ name: '计算"器"' })).toContain(
      'byName("计算\\"器\\"")',
    );
  });
});
