import { expect, test } from "vitest";

const { resolveLockedDirectoryName } = await import(
  "../src/components/workbench/zcode/lib/workspaceHeaderProvider.js"
);

test("resolveLockedDirectoryName：取目录末段（Win 反斜杠 / POSIX 正斜杠）", () => {
  expect(resolveLockedDirectoryName("D:\\Desktop\\test")).toBe("test");
  expect(resolveLockedDirectoryName("D:/Desktop/test")).toBe("test");
  expect(resolveLockedDirectoryName("/home/user/project")).toBe("project");
  expect(resolveLockedDirectoryName("D:\\Desktop\\test\\")).toBe("test");
  // 根路径与空串回退原串，不摆空 chip（"D:\" 分割后末段为盘符 "D:"）
  expect(resolveLockedDirectoryName("D:\\")).toBe("D:");
  expect(resolveLockedDirectoryName("")).toBe("");
});
