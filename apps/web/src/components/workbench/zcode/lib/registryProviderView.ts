/**
 * zcode 照搬：`@/lib/registryProviderView.ts`（references/zcode/packages/ui/src/lib/registryProviderView.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import type { ModelSelectionView } from "@zui/lib/zcode-services";

export function resolveProviderLabel(
  providerId: string | undefined,
  registryView: ModelSelectionView | null,
): string {
  const normalizedId = providerId?.trim() ?? "";
  if (!normalizedId) return "";
  const registryProvider = registryView?.providers.find(
    (provider) => provider.providerId === normalizedId,
  );
  if (registryProvider) {
    return registryProvider.providerName?.trim() || normalizedId;
  }
  return normalizedId;
}

export function resolveProviderBaseURL(
  providerId: string | undefined,
  registryView: ModelSelectionView | null,
): string | undefined {
  const normalizedId = providerId?.trim() ?? "";
  if (!normalizedId) return undefined;
  const registryProvider = registryView?.providers.find(
    (provider) => provider.providerId === normalizedId,
  );
  if (registryProvider) {
    return registryProvider.config.api?.baseUrl?.trim() || undefined;
  }
  return undefined;
}
