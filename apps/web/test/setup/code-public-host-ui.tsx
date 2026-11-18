import { type ReactNode, useMemo } from "react";
import type { CodeHttpChannelClient } from "../../src/components/workbench/zcode/host/httpChannelClient";

/** Node服务装配和独立DOM就绪后加载原Root的Provider；不替换其服务或store。 */
export async function loadCodePublicHostProviders() {
  const [
    intl,
    services,
    tabs,
    platformContext,
    platformFactory,
    tooltip,
    store,
    diffs,
    upgrade,
  ] = await Promise.all([
    import("@zui/i18n/IntlProvider"),
    import("@zui/hooks/useServices"),
    import("@zui/store/TabStoreProvider"),
    import("@zui/hooks/usePlatform"),
    import("../../src/components/workbench/zcode/host/platform"),
    import("@zui/components/ui/tooltip"),
    import("@zui/store/StoreProvider"),
    import("@zui/root/DiffsWorkerPoolProvider"),
    import("@zui/settings/CodingPlanUpgradeDialogProvider"),
  ]);
  return function OriginalProviders({
    client,
    children,
  }: {
    client: CodeHttpChannelClient;
    children: ReactNode;
  }) {
    const platform = useMemo(
      () => platformFactory.createCodePlatform(client),
      [client],
    );
    return (
      <intl.ZCodeIntlProvider initialLocale="zh-CN">
        <services.ServiceProvider services={client.services}>
          <platformContext.PlatformProvider platform={platform}>
            <tooltip.TooltipProvider>
              <store.StoreProvider
                broadcastService={client.services.broadcastService}
              >
                <tabs.TabStoreProvider>
                  <diffs.DiffsWorkerPoolProvider>
                    <upgrade.CodingPlanUpgradeDialogProvider>
                      {children}
                    </upgrade.CodingPlanUpgradeDialogProvider>
                  </diffs.DiffsWorkerPoolProvider>
                </tabs.TabStoreProvider>
              </store.StoreProvider>
            </tooltip.TooltipProvider>
          </platformContext.PlatformProvider>
        </services.ServiceProvider>
      </intl.ZCodeIntlProvider>
    );
  };
}
