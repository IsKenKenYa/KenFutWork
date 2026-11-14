import { describe, expect, it } from "vitest";
import { STDIO_NODE_OPTIONS, stdioNodeOptions } from "./windows-policy.js";

describe("Windows stdio 子进程的卷根路径解析", () => {
  it("非系统盘作用域注入 preserve-symlinks，避免 Node 的 realpath 卡在 lstat 'D:\\'", () => {
    expect(stdioNodeOptions(["D:\\Desktop\\test"], "C:\\Windows")).toBe(
      STDIO_NODE_OPTIONS,
    );
    // 工作目录在 C:、但 Node 或脚本在 D: 时同样会卡在 D:\。
    expect(
      stdioNodeOptions(
        ["C:\\work", "D:\\nvm\\.nodejs\\node.exe"],
        "C:\\Windows",
      ),
    ).toBe(STDIO_NODE_OPTIONS);
  });

  it("系统盘内与相对命令名不注入，保持原 Node 解析行为", () => {
    expect(
      stdioNodeOptions(
        ["C:\\work", "C:\\Program Files\\nodejs\\node.exe"],
        "C:\\Windows",
      ),
    ).toBeUndefined();
    expect(
      stdioNodeOptions(["C:\\work", "node", undefined], "C:\\Windows"),
    ).toBeUndefined();
    expect(stdioNodeOptions(["D:\\Desktop\\test"], "")).toBeUndefined();
  });
});
