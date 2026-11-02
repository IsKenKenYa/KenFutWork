import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.resetModules();
});

async function load() {
  vi.resetModules();
  const navigation = await import("@zui/lib/settingsNavigation.js");
  const { createSettingsPageConfig } = await import(
    "@zui/settings/settingsPageConfig.js"
  );
  const sections = createSettingsPageConfig({
    isMacDesktop: false,
    supportsComputerUse: false,
    supportsAutomations: false,
    supportsEmbeddedBrowser: true,
  }).settingsSections;
  return { navigation, sections };
}

it("设置导航不再单列 MCP 与技能分区", async () => {
  const { sections } = await load();
  const ids = sections.map((section) => section.id);
  expect(ids).toContain("plugin");
  expect(ids).not.toContain("mcp");
  expect(ids).not.toContain("skill");
});

it("旧独立分区 id 一律解析到插件分区", async () => {
  const { navigation } = await load();
  expect(navigation.resolveSettingsSection("mcp")).toBe("plugin");
  expect(navigation.resolveSettingsSection("skill")).toBe("plugin");
  expect(navigation.resolveSettingsSection("plugins")).toBe("plugin");
});

it("MCP 与技能意图落在插件分区的对应页签", async () => {
  const { navigation } = await load();
  navigation.setPendingSettingsPluginIntent("mcps");
  expect(navigation.consumeInitialSettingsSection()).toBe("plugin");
  expect(navigation.consumePendingSettingsPluginTab()).toBe("mcps");

  navigation.setPendingSettingsPluginIntent("skills");
  expect(navigation.consumeInitialSettingsSection()).toBe("plugin");
  expect(navigation.consumePendingSettingsPluginTab()).toBe("skills");
});

it("历史停留位迁移：上次停在 MCP，重开设置带回 MCP 页签", async () => {
  const { navigation } = await load();
  window.localStorage.setItem("zcode-settings-last-section", "mcp");
  expect(navigation.consumeInitialSettingsSection()).toBe("plugin");
  expect(navigation.consumePendingSettingsPluginTab()).toBe("mcps");
  expect(window.localStorage.getItem("zcode-settings-last-section")).toBe(
    "plugin",
  );
});
