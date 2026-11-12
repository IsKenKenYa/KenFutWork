import { describe, expect, it } from "vitest";

import {
  mergeConfiguredCommands,
  resolveConfiguredCommandPrompt,
} from "./command-input.js";

const instanceCommands = [
  { name: "open", description: "实例命令", prompt: "instance:$ARGUMENTS" },
];
const pluginCommands = [
  { name: "Open", description: "插件同名", prompt: "plugin:$ARGUMENTS" },
  { name: "tripo", description: "Tripo 工作流", prompt: "tripo:$ARGUMENTS" },
];

describe("命令来源合并", () => {
  it("实例同名优先，插件补充其余命令", () => {
    const merged = mergeConfiguredCommands(instanceCommands, pluginCommands);
    expect(merged.map((command) => command.name)).toEqual(["open", "tripo"]);
    expect(merged[0]?.prompt).toBe("instance:$ARGUMENTS");
  });

  it("插件命令可被 /name 触发并展开参数", () => {
    const merged = mergeConfiguredCommands(instanceCommands, pluginCommands);
    expect(resolveConfiguredCommandPrompt("/tripo 一只猫", merged)).toContain(
      "tripo:一只猫",
    );
  });

  it("实例命令仍然按原样展开", () => {
    const merged = mergeConfiguredCommands(instanceCommands, pluginCommands);
    expect(resolveConfiguredCommandPrompt("/open demo", merged)).toContain(
      "instance:demo",
    );
  });
});
