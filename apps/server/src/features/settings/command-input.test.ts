import { describe, expect, it } from "vitest";
import { resolveConfiguredCommandPrompt } from "./command-input.js";

const commands = [
  {
    name: "inspect",
    description: "检查项目",
    prompt: "检查 $ARGUMENTS 的实现",
  },
  {
    name: "init",
    description: "自定义初始化",
    prompt: "自定义初始化 $ARGUMENTS",
  },
];

describe("命令输入解析", () => {
  it("内置命令优先于同名自定义命令", () => {
    const resolved = resolveConfiguredCommandPrompt("/init 测试", commands);
    expect(resolved).toContain("AGENTS.md");
    expect(resolved).not.toContain("自定义初始化");
  });

  it("自定义命令按参数展开", () => {
    expect(resolveConfiguredCommandPrompt("/inspect 画布", commands)).toContain(
      "检查 画布 的实现",
    );
  });

  it("未知命令与非命令文本原样返回", () => {
    expect(resolveConfiguredCommandPrompt("/missing", commands)).toBe(
      "/missing",
    );
    expect(resolveConfiguredCommandPrompt("普通消息", commands)).toBe(
      "普通消息",
    );
  });

  it("自定义命令缺少配置时快速失败", () => {
    expect(() => resolveConfiguredCommandPrompt("/inspect", undefined)).toThrow(
      "命令配置读取失败",
    );
  });

  it("内置命令不依赖自定义命令配置", () => {
    expect(resolveConfiguredCommandPrompt("/review", undefined)).toContain(
      "未提交改动",
    );
  });
});
