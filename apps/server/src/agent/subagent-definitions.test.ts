import { describe, expect, it } from "vitest";

import {
  findSubagentDefinition,
  listSubagentDefinitions,
  resolveChildToolbelt,
  resolveSubagentDefinitions,
  SUBAGENT_DEFINITIONS,
  type SubagentDefinition,
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

describe("深度治理的结构性锁（DEC-17：深度上限 1）", () => {
  it("任何定义都不得声明派发工具（task/task_background/task_output）", () => {
    for (const def of SUBAGENT_DEFINITIONS) {
      const declared = [...def.tools, ...(def.filesystemTools ?? [])];
      for (const dispatch of ["task", "task_background", "task_output"]) {
        expect(declared, `${def.name} 声明了 ${dispatch}`).not.toContain(
          dispatch,
        );
      }
    }
  });

  it("只读定义的文件工具白名单不含 execute（结构性无执行能力）", () => {
    for (const def of SUBAGENT_DEFINITIONS) {
      if (def.readOnly && def.filesystemTools) {
        expect(def.filesystemTools).not.toContain("execute");
      }
    }
  });

  it("resolveChildToolbelt：父工具面混入派发工具也不会进子代理工具带", () => {
    const parentTools = [
      { name: "task", meta: "x" },
      { name: "subagent_task", meta: "x" },
      { name: "generate_image", meta: "x" },
    ];
    const batchImage = SUBAGENT_DEFINITIONS.find(
      (d) => d.name === "batch_image",
    );
    if (!batchImage) throw new Error("unreachable");
    const { tools } = resolveChildToolbelt(batchImage, parentTools);
    expect(tools.map((tool) => tool.name)).toEqual(["generate_image"]);
  });

  it("resolveChildToolbelt：定义声明派发工具时 fail loud（错误定义立即暴露）", () => {
    const bad = {
      ...SUBAGENT_DEFINITIONS[0],
      tools: ["task"],
    } as unknown as SubagentDefinition;
    expect(() =>
      resolveChildToolbelt(
        bad,
        SUBAGENT_DEFINITIONS.map(() => ({ name: "task" })),
      ),
    ).toThrow(/派发工具/);
  });
});
