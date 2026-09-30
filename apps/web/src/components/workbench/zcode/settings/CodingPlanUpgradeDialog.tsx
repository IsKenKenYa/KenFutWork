/**
 * zcode 照搬：`@/settings/CodingPlanUpgradeDialog.tsx`（references/zcode/packages/ui/src/settings/CodingPlanUpgradeDialog.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件接口可选属性放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记（P9）：购买缝服务（providerSettingsService / credentialService /
 * codingPlanSubscriptionService）宿主切片（hooks/useServices 禁改件）未声明；消费侧以
 * optional 切片类型访问——providerSettingsService 缺席时 refresh 经 ?. 得 undefined（并入
 * Promise.all 容错），credentialService 缺席时购买入口不渲染（未接通不出现）。
 */

import { useProviderSettingsView } from "@zui/hooks/useProviderSettingsView";
import { useServices, type ZCodeServiceSlice } from "@zui/hooks/useServices";
import {
  type EnterpriseCodingPlanPricingProduct,
  resolveModelProviderFamilyIdByProviderId,
} from "@zui/lib/zcode-shared";
import { logger } from "@zui/logger";
import { CodingPlanEmbeddedWebviewDialog } from "@zui/settings/CodingPlanEmbeddedWebviewDialog";
import {
  beginCodingPlanUpgradeLogin,
  type CodingPlanUpgradeDialogTarget,
  resolvePendingCodingPlanUpgradeAfterLogin,
} from "@zui/settings/codingPlanUpgradeLoginRecovery";
import { resolveCodingPlanUpgradeProductsProviderId } from "@zui/settings/model-provider-section/codingPlanPricingCards";
import { normalizeCodingPlanProviderId } from "@zui/settings/model-provider-section/codingPlanPurchaseAuth";
import type { CodingPlanProviderId } from "@zui/settings/model-provider-section/constants";
import { useCodingPlanEntitlements } from "@zui/settings/model-provider-section/useCodingPlanEntitlements";
import { useCallback } from "react";

export type { CodingPlanUpgradeDialogTarget } from "@zui/settings/codingPlanUpgradeLoginRecovery";
export {
  beginCodingPlanUpgradeLogin,
  resolvePendingCodingPlanUpgradeAfterLogin,
} from "@zui/settings/codingPlanUpgradeLoginRecovery";
export { isCodingPlanPurchaseAuthPending } from "@zui/settings/model-provider-section/codingPlanPurchaseAuth";

interface CodingPlanUpgradeDialogProps {
  target?: CodingPlanUpgradeDialogTarget | undefined;
  onClose: () => void;
  onOpenResult?: (opened: boolean) => void | undefined;
  // 兼容 CodingPlanUpgradeDialogProvider 现有契约。
  // 改造原因：购买/登录流程迁到官网 webview 内部后，App 不再需要「关闭弹窗去登录 → 成功后重开」
  // 的恢复链路；此 prop 当前不使用，保留签名避免改动 Provider。
  onReopen?: (target: CodingPlanUpgradeDialogTarget) => void | undefined;
}

/**
 * zcode 照搬（P9 补充）：购买缝服务的消费切片（签名逐字取自 references/zcode/packages/services；
 * 按本文件消费面收窄）。宿主 stub 下三服务均缺席：refreshProviderState 得 undefined（调用方
 * Promise.all/try-catch 容错），购买入口在 credentialService 缺席时不渲染。
 */
type CodingPlanUpgradeServiceSlice = {
  providerSettingsService?: { refresh(reason: string): Promise<unknown> };
  credentialService?: { load(key: string): Promise<string | null> };
  codingPlanSubscriptionService?: {
    getEnterprisePricing(params: {
      authenticated: boolean;
      family: string;
    }): Promise<{ productList: EnterpriseCodingPlanPricingProduct[] }>;
  };
};

// 完成刷新：官网页通过 window.zcodeBridge.notifyPurchaseComplete 回传购买成功后调用。
async function refreshCodingPlanUpgradeCompletion(params: {
  productsProviderId: CodingPlanProviderId | null;
  providerId: CodingPlanProviderId | null;
  refreshCodingPlanEntitlements: () => Promise<unknown> | unknown;
  refreshProviderState: () => Promise<unknown> | unknown;
  refreshTeamPlanProducts?: (() => Promise<unknown> | unknown) | undefined;
}) {
  await Promise.all([
    params.refreshProviderState(),
    params.refreshCodingPlanEntitlements(),
    // Team Plan 连接项依赖 authenticated pricing/customer 项目快照。
    // 全局购买弹窗关闭前也必须刷新它，避免 Done 后仍看不到新团队项目。
    params.refreshTeamPlanProducts?.(),
  ]);
}

async function closeAndRefreshCodingPlanUpgradeFromWebview(params: {
  onClose: () => void;
  refresh: () => Promise<unknown> | unknown;
  onRefreshError?: (error: unknown) => void | undefined;
}) {
  // 官网 webview 发回的完成信号语义是“关闭升级弹窗并刷新 provider”。
  // 关闭必须先发生，避免用户付款成功后还被弱网下的 provider/权益刷新阻塞在 webview 上。
  params.onClose();
  try {
    await params.refresh();
  } catch (error) {
    params.onRefreshError?.(error);
  }
}

export function CodingPlanUpgradeDialog({
  target,
  onClose,
  onOpenResult,
}: CodingPlanUpgradeDialogProps) {
  const {
    providerSettingsService,
    credentialService,
    codingPlanSubscriptionService,
  } = useServices() as ZCodeServiceSlice & CodingPlanUpgradeServiceSlice;
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready"
      ? providerSettingsRead.state.view
      : null;
  const { refresh: refreshCodingPlanEntitlements } = useCodingPlanEntitlements({
    providerSettingsView,
  });

  const providerId = normalizeCodingPlanProviderId(target?.providerId);
  const productsProviderId = providerId
    ? resolveCodingPlanUpgradeProductsProviderId(providerId)
    : null;
  const teamPlanFamily = productsProviderId
    ? resolveModelProviderFamilyIdByProviderId(productsProviderId)
    : null;
  const refreshProviderState = useCallback(
    () => providerSettingsService?.refresh("coding-plan-purchase-complete"),
    [providerSettingsService],
  );
  // 官网页购买完成回传：webview 告诉 App 关闭升级弹窗，并在后台刷新当前 provider。
  const handlePurchaseComplete = useCallback(async () => {
    await closeAndRefreshCodingPlanUpgradeFromWebview({
      onClose,
      refresh: () =>
        refreshCodingPlanUpgradeCompletion({
          productsProviderId,
          providerId,
          refreshCodingPlanEntitlements,
          refreshProviderState,
          refreshTeamPlanProducts:
            teamPlanFamily === null
              ? undefined
              : () =>
                  // 购买完成后会先关闭 webview 弹窗，弹窗内 hook 随即卸载。
                  // 这里直接走 service 拉取当前 family 的团队项目，避免刷新请求被卸载时序吞掉。
                  codingPlanSubscriptionService?.getEnterprisePricing({
                    authenticated: true,
                    family: teamPlanFamily,
                  }),
        }),
      onRefreshError: (error) => {
        // 刷新失败不阻塞关闭：用户已付款成功，套餐会在下次自然刷新时更新。
        logger.warn("[CodingPlanUpgradeDialog] 购买完成后刷新状态失败", {
          providerId,
          productsProviderId,
          error,
        });
      },
    });
  }, [
    codingPlanSubscriptionService,
    onClose,
    productsProviderId,
    providerId,
    refreshCodingPlanEntitlements,
    refreshProviderState,
    teamPlanFamily,
  ]);

  // credentialService 缺席 = 购买缝未接通：入口不渲染（未接通不出现），而非渲染后崩。
  if (!target || !providerId || !productsProviderId || !credentialService) {
    return null;
  }

  return (
    <CodingPlanEmbeddedWebviewDialog
      open={true}
      onOpenResult={onOpenResult}
      credentialService={credentialService}
      providerId={providerId}
      funnelContext={target.funnelContext}
      audience={target.initialAudience}
      teamPlanKey={target.initialTeamPlanKey}
      onPurchaseComplete={handlePurchaseComplete}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    />
  );
}
