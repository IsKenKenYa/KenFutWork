import { describe, expect, it } from "vitest";
import {
  builtinSlashCommandCatalog,
  mergeBuiltinSlashCommands,
  resolveBuiltinCommandPrompt,
} from "./builtin.js";

describe("内置斜杠命令目录", () => {
  it("列出 init 与 review，来源标记为 builtin", () => {
    const catalog = builtinSlashCommandCatalog();
    expect(catalog.map((entry) => entry.name)).toEqual(["init", "review"]);
    for (const entry of catalog) {
      expect(entry.source).toBe("builtin");
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.inputHint.startsWith("/")).toBe(true);
    }
  });

  it("自定义与内置重名时只保留内置，其余自定义保持原顺序", () => {
    const merged = mergeBuiltinSlashCommands([
      { name: "inspect", description: "检查项目", source: "custom" as const },
      { name: "/init", description: "自定义初始化", source: "custom" as const },
      { name: "review", description: "自定义检查", source: "custom" as const },
      { name: "  ", description: "空名", source: "custom" as const },
    ]);
    expect(merged.map((entry) => entry.name)).toEqual([
      "init",
      "review",
      "inspect",
    ]);
  });

  it("空自定义目录仍返回内置命令", () => {
    expect(mergeBuiltinSlashCommands([]).map((entry) => entry.name)).toEqual([
      "init",
      "review",
    ]);
  });
});

describe("内置命令展开", () => {
  it("init 带补充要求时把要求拼进输入", () => {
    expect(resolveBuiltinCommandPrompt("init", "只写测试命令")).toContain(
      "补充要求：只写测试命令",
    );
  });

  it("无参数也给出可执行行为", () => {
    expect(resolveBuiltinCommandPrompt("review", "")).toContain(
      "重点看正确性、边界与回归风险",
    );
  });

  it("大小写与前导斜杠不影响命中", () => {
    expect(resolveBuiltinCommandPrompt("/INIT", "")).toContain("AGENTS.md");
  });

  it("未命中返回 null，交给自定义命令", () => {
    expect(resolveBuiltinCommandPrompt("inspect", "")).toBeNull();
  });
});
