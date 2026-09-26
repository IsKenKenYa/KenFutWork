import { describe, expect, it } from "vitest";

import {
  findSubagentDefinition,
  listSubagentDefinitions,
  resolveSubagentDefinitions,
} from "./subagent-definitions.js";

describe("子代理定义注册表（DEC-16）", () => {
  it("按 preset 过滤：shared 恒在，design/code 各取本模式", () => {
    expect(resolveSubagentDefinitions("design").map((d) => d.name)).toEqual([
      "planner",
      "batch_image",
      "video_generate",
    ]);
    expect(resolveSubagentDefinitions("code").map((d) => d.name)).toEqual([
      "explore",
      "review",
      "video_generate",
    ]);
  });

  it("explore/review/planner 是只读定义（plan 白名单判据），生成类不是", () => {
    const byName = (name: string) =>
      resolveSubagentDefinitions("code")
        .concat(resolveSubagentDefinitions("design"))
        .find((d) => d.name === name);
    expect(byName("explore")?.readOnly).toBe(true);
    expect(byName("review")?.readOnly).toBe(true);
    expect(byName("planner")?.readOnly).toBe(true);
    expect(byName("batch_image")?.readOnly).toBe(false);
    expect(byName("video_generate")?.readOnly).toBe(false);
  });

  it("只读定义的文件工具白名单不含 execute（结构性无执行能力）", () => {
    for (const def of resolveSubagentDefinitions("code")) {
      if (def.readOnly) {
        expect(def.filesystemTools).toBeDefined();
        expect(def.filesystemTools).not.toContain("execute");
      }
    }
  });

  it("未知名字返回 undefined；界面清单与定义同源", () => {
    expect(findSubagentDefinition("code", "nope")).toBeUndefined();
    const listed = listSubagentDefinitions().map((entry) => entry.name);
    expect(listed).toContain("explore");
    expect(listed).toContain("video_generate");
  });
});
