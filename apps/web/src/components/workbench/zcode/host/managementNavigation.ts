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
  const parsed = managementTargetSchema.safeParse({
    page: "settings",
    section,
    ...(model ? { modelProviderId: model.providerId } : {}),
    ...(pluginTab ? { pluginTab } : {}),
    ...(pluginOrigin ? { pluginOrigin } : {}),
    ...(pluginScope ? { pluginScopeKey: "user" } : {}),
    ...(usageTab === "app" ? { usageTab } : {}),
  });
  // 分区偏好由上游独立演进并持久化，未知值只回退默认入口：抛异常会让设置按钮静默变砖。
  return parsed.success
    ? parsed.data
    : { page: "settings", section: "general" };
}

export function requestManagementOpen(target: ManagementTarget) {
  window.parent.postMessage(
    { type: "kenfutwork:open-management", target },
    window.location.origin,
  );
}
