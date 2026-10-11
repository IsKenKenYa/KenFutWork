import { describe, expect, it } from "vitest";
import { unixRuntimeReadRoots } from "./policy.js";

describe("沙箱运行时读取基线", () => {
  it("darwin 授予第三方工具链前缀（git 装在 /opt/homebrew，不在 /usr 之下）", () => {
    const roots = unixRuntimeReadRoots([], "darwin");
    // 缺这一条时，沙箱内 `env git …` 报 Operation not permitted：影子检查点恒空。
    expect(roots).toContain("/opt/homebrew");
    expect(roots).toContain("/usr");
    expect(roots).toContain("/System");
  });

  it("非 darwin 不引入 macOS 专有前缀", () => {
    expect(unixRuntimeReadRoots([], "linux")).not.toContain("/opt/homebrew");
  });

  it("基线只覆盖软件目录，不放开用户数据目录", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(unixRuntimeReadRoots([], platform)).not.toContain("/Users");
      expect(unixRuntimeReadRoots([], platform)).not.toContain("/home");
      expect(unixRuntimeReadRoots([], platform)).not.toContain("/var");
    }
  });

  it("调用方追加的运行时根参与去重", () => {
    const roots = unixRuntimeReadRoots(["/opt/custom/runtime", "/usr"]);
    expect(roots).toContain("/opt/custom/runtime");
    expect(roots.filter((path) => path === "/usr")).toHaveLength(1);
  });
});
