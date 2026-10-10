import type { ManagementTarget } from "@kenfutwork/shared";
import { TooltipProvider } from "@zui/components/ui/tooltip.js";
import { ScopedErrorBoundary } from "@zui/ErrorBoundary.js";
import { PlatformProvider } from "@zui/hooks/usePlatform.js";
import { ServiceProvider } from "@zui/hooks/useServices.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import {
  addPluginStoreOpenListener,
  requestPluginStoreOpen,
} from "@zui/lib/pluginStoreNavigation.js";
import { setPendingSettingsSectionIntent } from "@zui/lib/settingsNavigation.js";
import { RootShell } from "@zui/root/RootShell.js";
import { SettingsPage } from "@zui/SettingsPage.js";
import { AutomationsMainBreadcrumbFrame } from "@zui/settings/AutomationsMainBreadcrumbFrame.js";
import { CodingPlanUpgradeDialogProvider } from "@zui/settings/CodingPlanUpgradeDialogProvider.js";
import { PluginStorePage } from "@zui/settings/PluginStorePage.js";
import { setMcpStorePlatform } from "@zui/store/mcpStore.js";
import { StoreProvider } from "@zui/store/StoreProvider.js";
import { TabStoreProvider } from "@zui/store/TabStoreProvider.js";
import { LucideProvider } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { Root } from "react-dom/client";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";
import { createCodePlatform } from "./platform.js";

function prepareTarget(target: ManagementTarget) {
  if (target.page === "settings" && target.section)
    setPendingSettingsSectionIntent(target.section, {
      ...(target.pluginTab ? { pluginTab: target.pluginTab } : {}),
      ...(target.pluginOrigin ? { pluginOrigin: target.pluginOrigin } : {}),
      ...(target.pluginScopeKey
        ? { pluginScopeKey: target.pluginScopeKey }
        : {}),
      ...(target.modelProviderId
        ? { modelProviderId: target.modelProviderId }
        : {}),
      ...(target.usageTab ? { usageTab: target.usageTab } : {}),
    });
  if (target.page === "plugins")
    requestPluginStoreOpen({
      ...(target.pluginId ? { pluginId: target.pluginId } : {}),
      ...(target.intent ? { intent: target.intent } : {}),
      ...(target.returnScopeKey
        ? { returnScopeKey: target.returnScopeKey }
        : {}),
    });
}

function ManagementDocument({
  client,
  initialTarget,
  onClose,
}: {
  client: CodeHttpChannelClient;
  initialTarget: ManagementTarget;
  onClose: () => void;
}) {
  const services = useSyncExternalStore(
    client.subscribeServices,
    () => client.services,
  );
  const platform = useMemo(
    () => ({
      ...createCodePlatform(client),
      supportsInterfaceModeSettings: false,
    }),
    [client],
  );
  const [target, setTarget] = useState(initialTarget);
  useLayoutEffect(() => {
    setMcpStorePlatform(platform);
    return () => setMcpStorePlatform(null);
  }, [platform]);
  useEffect(
    () =>
      addPluginStoreOpenListener((next) =>
        setTarget({ page: "plugins", ...next, returnScopeKey: "user" }),
      ),
    [],
  );
  const manageInstalled = () => {
    const next: ManagementTarget = {
      page: "settings",
      section: "plugin",
      pluginTab: "plugins",
      pluginOrigin: "plugin-store",
      pluginScopeKey: "user",
    };
    prepareTarget(next);
    setTarget(next);
  };
  return (
    <LucideProvider strokeWidth={1.5}>
      <TooltipProvider>
        <ServiceProvider services={services}>
          <PlatformProvider platform={platform}>
            <StoreProvider
              broadcastService={services.broadcastService}
              onInterfaceModeChange={() => {}}
            >
              <TabStoreProvider>
                <CodingPlanUpgradeDialogProvider>
                  <ZCodeIntlProvider
                    initialLocale="zh-CN"
                    settingService={services.settingService}
                    broadcastService={services.broadcastService}
                  >
                    <ScopedErrorBoundary scope="management-document">
                      <RootShell>
                        {target.page === "settings" ? (
                          <SettingsPage
                            onBack={onClose}
                            onOpenPluginStore={(next) => {
                              const destination: ManagementTarget = {
                                page: "plugins",
                                ...next,
                                returnScopeKey: "user",
                              };
                              prepareTarget(destination);
                              setTarget(destination);
                            }}
                            allowOpenWorkspace={false}
                            user={null}
                          />
                        ) : (
                          <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
                            <AutomationsMainBreadcrumbFrame
                              isDesktop={false}
                              sectionLabel="插件市场"
                              ariaLabel="导航"
                            >
                              <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                                <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                                  <PluginStorePage
                                    onManageInstalled={manageInstalled}
                                    onBack={onClose}
                                  />
                                </div>
                              </div>
                            </AutomationsMainBreadcrumbFrame>
                          </main>
                        )}
                      </RootShell>
                    </ScopedErrorBoundary>
                  </ZCodeIntlProvider>
                </CodingPlanUpgradeDialogProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}

/** 原页面的独立入口：复用providers、store、页面和market内容容器，不启动Root工作区。 */
export function renderManagementDocument(
  root: Root,
  client: CodeHttpChannelClient,
  target: ManagementTarget,
  onClose: () => void,
) {
  prepareTarget(target);
  root.render(
    <ManagementDocument
      client={client}
      initialTarget={target}
      onClose={onClose}
    />,
  );
}
