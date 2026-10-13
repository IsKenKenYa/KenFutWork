import { Button } from "@zui/components/ui/button.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";

/**
 * KenFutWork 宿主偏差组件：BYOK-only 形态关闭云账号后，零供应商时原导航恒空，
 * 原实现的 !selectedNavItem 分支会把这一稳态误渲染成加载占位。此卡是它的空态。
 */
export function ModelProviderEmptyState({
  onAddProvider,
}: {
  onAddProvider: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex flex-col items-start gap-3 rounded-xl border border-border bg-surface p-4"
      data-testid="model-provider-empty-state"
    >
      <div className="text-ui-lg font-semibold text-foreground">
        {intl.formatMessage({ id: "settings.modelProvider.emptyTitle" })}
      </div>
      <Button type="button" onClick={onAddProvider}>
        {intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      </Button>
    </div>
  );
}
