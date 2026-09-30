/**
 * zcode 照搬：`@/hooks/useCodingPlanEntryPlanList.ts`（references/zcode/packages/ui/src/hooks/useCodingPlanEntryPlanList.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记（P9）：购买缝服务（credentialService / codingPlanSubscriptionService）宿主切片
 * （hooks/useServices 禁改件）未声明；消费侧以 optional 切片类型访问——运行时缺失时方法调用
 * 在 undefined 上 TypeError，被既有 try/catch 捕获落 products=null，UI 自动降级为不可用。
 */

import { useProviderSettingsView } from "@zui/hooks/useProviderSettingsView";
import { useServices, type ZCodeServiceSlice } from "@zui/hooks/useServices";
import { resolveAccountProviderInspectionAccess } from "@zui/lib/accountProviderAccess";
import { buildOwnedEntryPlanList } from "@zui/lib/codingPlanOwnedEntryPlans";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type EnterpriseCodingPlanPricingProduct,
} from "@zui/lib/zcode-shared";
import { logger } from "@zui/logger";
import { useCodingPlanEntitlements } from "@zui/settings/model-provider-section/useCodingPlanEntitlements";
import { useZCodeStore } from "@zui/store/StoreProvider";
import { useCallback, useEffect, useState } from "react";

/**
 * zcode 照搬（P9 补充）：购买缝服务的消费切片（签名逐字取自 references/zcode/packages/services
 * 的 ICredentialService / ICodingPlanSubscriptionService；按本 hook 消费面收窄）。
 */
type CodingPlanEntryServiceSlice = {
  credentialService?: { load(key: string): Promise<string | null> };
  codingPlanSubscriptionService?: {
    getEnterprisePricing(params: {
      authenticated: boolean;
      family: "bigmodel" | "zai";
    }): Promise<{ productList: EnterpriseCodingPlanPricingProduct[] }>;
  };
};

export interface CodingPlanEntryInventory {
  entryPlanList: string;
  status: "loading" | "error" | "ready";
  retry: () => void;
}

export function useCodingPlanEntryPlanList(): CodingPlanEntryInventory {
  const { state, reload } = useProviderSettingsView();
  const providerSettingsView = state.status === "ready" ? state.view : null;
  const loading = state.status === "loading";
  // 适配注记（P9）：宿主切片未声明购买缝服务，消费侧按 optional 切片访问降级（见文件头注记）。
  const { credentialService, codingPlanSubscriptionService } =
    useServices() as ZCodeServiceSlice & CodingPlanEntryServiceSlice;
  const user = useZCodeStore((state) => state.user);
  // 不传当前选中的团队上下文，四种 Start/个人连接分别使用已有权益缓存。
  const { entitlements, refresh } = useCodingPlanEntitlements({
    providerSettingsView,
    suppressProviderFingerprintAutoRefresh: true,
  });
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => {
    if (state.status === "error") reload();
    setGeneration((value) => value + 1);
  }, [state.status, reload]);
  const [teams, setTeams] = useState<{
    user: typeof user;
    view: typeof providerSettingsView;
    sources: {
      token: string | null;
      products: EnterpriseCodingPlanPricingProduct[] | null;
    }[];
    generation: number;
  } | null>(null);
  useEffect(() => {
    if (!providerSettingsView) return;
    let cancelled = false;
    // 团队订阅以 authenticated pricing 为准，不用静态商品目录推断已购套餐。
    void Promise.all([
      refresh({ force: true, silent: true }),
      Promise.all(
        (["bigmodel", "zai"] as const).map(async (family) => {
          let token: string | null = null;
          try {
            token =
              (
                await credentialService?.load(`oauth:${family}:access_token`)
              )?.trim() || null;
            if (!token) return { token, products: [] };
            const result =
              await codingPlanSubscriptionService?.getEnterprisePricing({
                authenticated: true,
                family,
              });
            // 适配注记（P9）：service 缺席时 result 为 undefined，落 products=null（与 catch 同一降级）。
            return { token, products: result?.productList ?? null };
          } catch (error) {
            logger.warn("[purchaseTelemetry] 读取团队套餐失败", {
              family,
              error,
            });
            return { token, products: null };
          }
        }),
      ),
    ]).then(([, sources]) => {
      if (!cancelled)
        setTeams((previous) => ({
          user,
          view: providerSettingsView,
          generation,
          sources: sources.map((source, index) => {
            // 刷新失败不等于未购；仅在账号、family 和凭据一致时复用成功结果。
            const cached = previous?.sources[index];
            return source.products === null &&
              source.token &&
              previous?.user === user &&
              cached?.token === source.token
              ? { ...source, products: cached.products }
              : source;
          }),
        }));
    });
    return () => {
      cancelled = true;
    };
  }, [
    credentialService,
    codingPlanSubscriptionService,
    user,
    providerSettingsView,
    generation,
    loading,
    refresh,
  ]);
  const sameIdentity =
    teams !== null &&
    teams.user === user &&
    teams.view === providerSettingsView;
  const current = sameIdentity && teams.generation === generation;
  const usableTeams =
    sameIdentity && teams.sources.every((source) => source.products !== null);
  const planIds: readonly string[] = [
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  ];
  // 账号模型没有 Personal API Key；沿用权益 hook 的只读 Access 判定，不能过滤未选中/禁用套餐。
  const required = planIds
    .filter((providerId) =>
      resolveAccountProviderInspectionAccess(providerSettingsView, providerId),
    )
    .map((providerId) => entitlements[providerId]);
  // 错误描述的是本次刷新，不能否定仍可用的历史快照（含成功确认未开通）。
  const missing = required.filter((item) => {
    const snapshot = item?.snapshot;
    return (
      !snapshot ||
      (snapshot.unavailableReason !== "no_plan" &&
        (!snapshot.authenticated || snapshot.unavailableReason))
    );
  });
  const pending = loading || !current || missing.some((item) => item?.loading);
  const failed = !usableTeams || missing.length > 0;
  const status =
    state.status === "error"
      ? "error"
      : pending
        ? "loading"
        : failed
          ? "error"
          : "ready";
  useEffect(() => {
    logger.debug("[purchaseTelemetry] 套餐入口查询状态", {
      status,
      configuredSources: required.length,
      generation,
    });
  }, [status, required.length, generation]);
  return {
    status,
    retry,
    entryPlanList:
      status === "ready"
        ? buildOwnedEntryPlanList({
            snapshots: required.map((item) => item?.snapshot),
            teamProducts:
              teams?.sources.flatMap((source) => source.products ?? []) ?? [],
          })
        : "",
  };
}
