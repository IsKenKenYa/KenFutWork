import type { SettingsSectionId } from "@zui/lib/settingsNavigation.js";

// 翻译 key 同时作为稳定定位 id；索引只描述入口，不持有任何配置值。
export const SETTINGS_SEARCH_ITEMS = [
  { id: "settings.locale", section: "general", description: "settings.localeDescription" },
  { id: "settings.terminalProfile", section: "general", description: "settings.terminalProfileDescription" },
  { id: "settings.terminalFontFamily", section: "general", description: "settings.terminalFontFamilyDescription" },
  { id: "settings.httpProxy", section: "general", description: "settings.httpProxyDescription" },
  { id: "settings.httpProxyNoProxy", section: "general", description: "settings.httpProxyNoProxyDescription" },
  { id: "settings.httpProxyCaCertPath", section: "general", description: "settings.httpProxyCaCertPathDescription" },
  { id: "settings.notification", section: "general", description: "settings.notificationDescription" },
  { id: "settings.notificationSound", section: "general", description: "settings.notificationSoundDescription" },
  { id: "settings.dataBaseDir", section: "general", description: "settings.dataBaseDirDescription" },
  { id: "settings.zcodeInteractionBehavior", section: "general", description: "settings.zcodeInteractionBehaviorDescription" },
  { id: "settings.messageStreamShowReasoning", section: "general", description: "settings.messageStreamShowReasoningDescription" },
  { id: "settings.messageStreamShowTodos", section: "general", description: "settings.messageStreamShowTodosDescription" },
  { id: "settings.toolGroupingExplore", section: "general", description: "settings.toolGroupingExploreDescription" },
  { id: "settings.toolGroupingTerminal", section: "general", description: "settings.toolGroupingTerminalDescription" },
  { id: "settings.toolGroupingChanges", section: "general", description: "settings.toolGroupingChangesDescription" },
  { id: "settings.themeMode", section: "appearance", description: "settings.themeModeDescription" },
  { id: "settings.uiFontSize", section: "appearance", description: "settings.uiFontSizeDescription" },
  { id: "settings.lightTheme", section: "appearance", description: "settings.lightThemeDescription" },
  { id: "settings.darkTheme", section: "appearance", description: "settings.darkThemeDescription" },
  { id: "settings.showLineNumbers", section: "appearance", description: "settings.showLineNumbersDescription" },
  { id: "settings.wrapLongLines", section: "appearance", description: "settings.wrapLongLinesDescription" },
  { id: "settings.fontSize", section: "appearance", description: "settings.fontSizeDescription" },
] as const satisfies readonly {
  id: string;
  section: SettingsSectionId;
  description: string;
}[];

export type SettingsSearchId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];
