/**
 * zcode 照搬：`@/lib/startPlanEntitlementOptions.ts`（references/zcode/packages/ui/src/lib/startPlanEntitlementOptions.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import type { UseUsageEntitlementOptions } from "@zui/hooks/useUsageEntitlement";
import { resolveAccountProviderInspectionAccess } from "@zui/lib/accountProviderAccess";
import { buildUsageEntitlementCacheKey } from "@zui/lib/usageEntitlementCache";
import type { ProviderSettingsView } from "@zui/lib/zcode-services";
import { resolveModelProviderFamilySpecByProviderId } from "@zui/lib/zcode-shared";

/** 设置、输入框与提交推荐复用原权益缓存；账号身份由 Account Source 的连接指纹提供。 */
export function buildStartPlanEntitlementOptions(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): UseUsageEntitlementOptions {
  const inspection = resolveAccountProviderInspectionAccess(view, providerId);
  const provider = view?.providers.find(
    (entry) => entry.providerId === providerId,
  );
  const family = resolveModelProviderFamilySpecByProviderId(providerId);
  const fingerprint = inspection
    ? JSON.stringify([
        provider?.accountState?.connectionKey ?? view?.revision,
        inspection,
      ])
    : "";
  return {
    enabled: Boolean(inspection && family),
    preferredProviderId: providerId,
    accountAccess: family
      ? { type: "zhipu-account", family: family.id, planKind: "start-plan" }
      : undefined,
    includeSubscription: true,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId,
      providerFingerprint: fingerprint,
    }),
    refreshOnMount: false,
  };
}
