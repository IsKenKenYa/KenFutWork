import { ChildProcess, execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  normalizeAxNode,
  normalizeRole,
  runJxa,
  toJxaAppSelector,
} from "./jxa.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

const execFileMock = vi.mocked(execFile);

function rejectExecFileWith(stderr: string) {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    if (typeof callback !== "function")
      throw new Error("测试需要 execFile callback");
    callback(
      Object.assign(new Error("osascript failed"), { code: 1 }),
      "",
      stderr,
    );
    return new ChildProcess();
  });
}

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

describe("runJxa（桥接错误分类）", () => {
  it("macOS 本地化 AX 拒绝按系统错误码归类为权限拒绝", async () => {
    const stderr =
      "execution error: Error: Error: “osascript”不允许辅助访问。 (-25211)";
    rejectExecFileWith(stderr);

    await expect(runJxa("JSON.stringify([]);", 1_000)).rejects.toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining(stderr),
    });
  });

  it("保留显式权限拒绝前缀分类", async () => {
    rejectExecFileWith(
      "permission_denied: accessibility permission is missing",
    );

    await expect(runJxa("JSON.stringify([]);", 1_000)).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("取消优先于桥接权限错误分类", async () => {
    const controller = new AbortController();
    controller.abort();
    rejectExecFileWith("(-25211)");

    await expect(
      runJxa("JSON.stringify([]);", 1_000, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("未知JXA错误仍归类为internal", async () => {
    rejectExecFileWith("execution error: unexpected failure (-99999)");

    await expect(runJxa("JSON.stringify([]);", 1_000)).rejects.toMatchObject({
      code: "internal",
    });
  });
});
