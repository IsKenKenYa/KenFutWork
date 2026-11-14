import { describe, expect, it } from "vitest";

import { isSettingsSectionEnabled } from "../src/components/workbench/zcode/lib/settingsNavigation";
import { createSettingsPageConfig } from "../src/components/workbench/zcode/settings/settingsPageConfig";

/**
 * 子智能体已接通只读清单（`subagents.list`），导航保留入口；
 * 命令/钩子仍没有 hostRpc 处理器（请求返回 501），导航必须隐藏。
 */
describe("设置导航：只接通只读的分区才出现", () => {
  it("子智能体进入导航且可用；命令/钩子继续隐藏", () => {
    const sectionIds = createSettingsPageConfig({
      supportsAutomations: false,
      supportsEmbeddedBrowser: true,
      supportsComputerUse: false,
    }).settingsSections.map((section) => section.id);

    expect(sectionIds).toContain("subagents");
    expect(isSettingsSectionEnabled("subagents")).toBe(true);
    expect(sectionIds).not.toContain("commands");
    expect(sectionIds).not.toContain("hooks");
    for (const section of ["commands", "hooks"] as const) {
      expect(isSettingsSectionEnabled(section)).toBe(false);
    }
  });

  it("记忆与插件等已接通分区仍然保留", () => {
    const sectionIds = createSettingsPageConfig({
      supportsAutomations: false,
      supportsEmbeddedBrowser: true,
      supportsComputerUse: false,
    }).settingsSections.map((section) => section.id);

    expect(sectionIds).toContain("memory");
    expect(sectionIds).toContain("plugin");
    // 主线的「插件·MCP·技能」并页：MCP 与技能不再单列导航项。
    expect(sectionIds).not.toContain("mcp");
    expect(sectionIds).not.toContain("skill");
  });
});
