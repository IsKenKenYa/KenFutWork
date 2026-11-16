import type { SettingsSectionId } from "@zui/lib/settingsNavigation.js";
import type { SettingsSearchId } from "@zui/settings-search/settingsSearchIndex.js";

/** 仅导航到分类或固定设置行；调用方不得据此修改设置值。 */
export interface SettingsSearchResult {
  section: SettingsSectionId;
  setting?: SettingsSearchId;
}

export type { SettingsSearchId } from "@zui/settings-search/settingsSearchIndex.js";
export { useSettingsSearchTarget } from "@zui/settings-search/SettingsSearchTarget.js";
