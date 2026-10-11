import {
  type ManagementTarget,
  managementTargetSchema,
} from "@kenfutwork/shared";
import {
  clearPendingSettingsPluginOrigin,
  clearPendingSettingsPluginScopeKey,
  consumeInitialSettingsSection,
  consumePendingSettingsModelProviderTarget,
  consumePendingSettingsPluginOrigin,
  consumePendingSettingsPluginScopeKey,
  consumePendingSettingsPluginTab,
  consumePendingSettingsUsageTab,
} from "@zui/lib/settingsNavigation.js";

/** 原导航解析器承接意图；宿主只转换其合法结果，不另存设置。 */
export function readManagementSettingsTarget(): ManagementTarget {
  const section = consumeInitialSettingsSection();
  const model = consumePendingSettingsModelProviderTarget();
  const pluginTab = consumePendingSettingsPluginTab();
  const pluginOrigin = consumePendingSettingsPluginOrigin();
  const pluginScope = consumePendingSettingsPluginScopeKey();
  const usageTab = consumePendingSettingsUsageTab();
  clearPendingSettingsPluginOrigin();
  clearPendingSettingsPluginScopeKey();
  return managementTargetSchema.parse({
    page: "settings",
    section,
    ...(model ? { modelProviderId: model.providerId } : {}),
    ...(pluginTab ? { pluginTab } : {}),
    ...(pluginOrigin ? { pluginOrigin } : {}),
    ...(pluginScope ? { pluginScopeKey: "user" } : {}),
    ...(usageTab === "app" ? { usageTab } : {}),
  });
}

export function requestManagementOpen(target: ManagementTarget) {
  window.parent.postMessage(
    { type: "kenfutwork:open-management", target },
    window.location.origin,
  );
}
