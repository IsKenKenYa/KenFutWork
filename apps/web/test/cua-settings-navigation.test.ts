import { afterEach, expect, it, vi } from "vitest";

const host = window as Window & {
  __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
};
afterEach(() => {
  delete host.__TAURI_INTERNALS__;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.resetModules();
});

it("普通Web继续隐藏电脑控制入口", async () => {
  vi.resetModules();
  const navigation = await import("@zui/lib/settingsNavigation.js");
  expect(navigation.isSettingsSectionEnabled("computerUse")).toBe(false);
});

it("原生宿主显示原电脑控制分区并沿原导航持久化与消费意图", async () => {
  host.__TAURI_INTERNALS__ = { invoke: async () => ({}) };
  vi.resetModules();
  const navigation = await import("@zui/lib/settingsNavigation.js");
  const { createSettingsPageConfig } = await import(
    "@zui/settings/settingsPageConfig.js"
  );
  const sections = createSettingsPageConfig({
    isMacDesktop: true,
    supportsComputerUse: true,
    supportsAutomations: false,
    supportsEmbeddedBrowser: false,
  }).settingsSections;
  expect(sections.map((section) => section.id)).toContain("computerUse");
  expect(sections.map((section) => section.id)).not.toContain("browser");
  navigation.setPendingSettingsSectionIntent("computerUse");
  expect(navigation.consumeInitialSettingsSection()).toBe("computerUse");
  navigation.writeLastSettingsSectionPreference("computerUse");
  expect(navigation.consumeInitialSettingsSection()).toBe("computerUse");
});
