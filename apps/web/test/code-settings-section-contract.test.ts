import { managementTargetSchema } from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import { readManagementSettingsTarget } from "../src/components/workbench/zcode/host/managementNavigation";
import {
  type SettingsSectionId,
  writeLastSettingsSectionPreference,
} from "../src/components/workbench/zcode/lib/settingsNavigation";
import { createSettingsPageConfig } from "../src/components/workbench/zcode/settings/settingsPageConfig";

const LAST_SECTION_KEY = "zcode-settings-last-section";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

// 分区集合由上游 ZCode 独立演进，宿主契约是另一份枚举：两边漂移过一次就把设置
// 按钮变成静默砖（持久化的 voice 不在宿主枚举里，点击同步抛 ZodError）。这里用真实
// 分区目录逐个走「写入偏好 → 打开设置」的完整路径，新增分区漏补契约时直接红。
const catalogSections = createSettingsPageConfig({
  isDesktop: true,
  supportsAutomations: true,
  supportsEmbeddedBrowser: true,
  supportsComputerUse: true,
}).settingsSections.map((section) => section.id);

// 目录之外仍可被持久化的合法 id（不在设置页目录里，但类型与读取路径都接受）。
const persistableOnly: SettingsSectionId[] = ["migration", "openDesign"];

it.each([...catalogSections, ...persistableOnly])(
  "上次停留分区 %s 能打开设置，不被宿主契约拒绝",
  (section) => {
    writeLastSettingsSectionPreference(section);
    expect(localStorage.getItem(LAST_SECTION_KEY)).toBe(section);

    const target = readManagementSettingsTarget();

    expect(target).toMatchObject({ page: "settings", section });
    expect(managementTargetSchema.safeParse(target).success).toBe(true);
  },
);

it("回归：持久化的 voice 不再让设置入口抛异常", () => {
  localStorage.setItem(LAST_SECTION_KEY, "voice");

  expect(() => readManagementSettingsTarget()).not.toThrow();
  expect(readManagementSettingsTarget()).toMatchObject({
    page: "settings",
    section: "voice",
  });
});

it.each(["automations", "workspaceFileSearch", "plugins", "mcp", "skill"])(
  "隐藏或已合并的旧分区 %s 落到可用入口，而不是抛异常",
  (section) => {
    localStorage.setItem(LAST_SECTION_KEY, section);

    const target = readManagementSettingsTarget();

    expect(managementTargetSchema.safeParse(target).success).toBe(true);
    expect(target.page).toBe("settings");
  },
);

it.each(["", "not-a-section", "voice ", "GENERAL"])(
  "无法识别的持久化值 %j 回退默认入口，设置按钮仍然可用",
  (raw) => {
    localStorage.setItem(LAST_SECTION_KEY, raw);

    const target = readManagementSettingsTarget();

    expect(managementTargetSchema.safeParse(target).success).toBe(true);
    expect(target).toMatchObject({ page: "settings", section: "general" });
  },
);

it("没有持久化偏好时默认进常规分区", () => {
  expect(readManagementSettingsTarget()).toMatchObject({
    page: "settings",
    section: "general",
  });
});
