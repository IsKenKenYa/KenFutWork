import { describe, expect, it } from "vitest";

import { isSettingsSectionEnabled } from "../src/components/workbench/zcode/lib/settingsNavigation";
import { createSettingsPageConfig } from "../src/components/workbench/zcode/settings/settingsPageConfig";

/**
 * 本宿主没有原 zcode 文件型子智能体/命令/钩子设置的数据通道
 * （服务端 hostRpc 无处理器，请求返回 501）。导航必须隐藏这三个分区，
 * 不保留按下必失败的入口。
 */
describe("设置导航：未接通的 zcode 文件型分区不出现", () => {
  it("子智能体/命令/钩子既不进入导航，也不被当作可用分区", () => {
    const sectionIds = createSettingsPageConfig({
      supportsAutomations: false,
      supportsEmbeddedBrowser: true,
      supportsComputerUse: false,
    }).settingsSections.map((section) => section.id);

    expect(sectionIds).not.toContain("subagents");
    expect(sectionIds).not.toContain("commands");
    expect(sectionIds).not.toContain("hooks");
    for (const section of ["subagents", "commands", "hooks"] as const) {
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
    expect(sectionIds).toContain("mcp");
    expect(sectionIds).toContain("skill");
  });
});
