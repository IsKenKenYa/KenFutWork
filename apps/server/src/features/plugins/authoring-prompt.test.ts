import { expect, it } from "vitest";
import { SystemPromptRegistryImpl } from "../../kernel/context.js";
import { pluginAuthoringPromptSection } from "./authoring-prompt.js";

it.each(["code", "design"] as const)(
  "%s 的普通 Agent 可取得技能和插件制作指导",
  async (preset) => {
    const registry = new SystemPromptRegistryImpl();
    const unregister = registry.register(pluginAuthoringPromptSection);
    const prompt = await registry.compose({ preset });
    expect(prompt).toContain("ToolSearch");
    expect(prompt).toContain("create_skill");
    expect(prompt).toContain("install_plugin");
    expect(prompt).toContain("create_mcp_server");
    expect(prompt).toContain("Task 授权目录");
    unregister();
    expect(await registry.compose({ preset })).toBe("");
  },
);
