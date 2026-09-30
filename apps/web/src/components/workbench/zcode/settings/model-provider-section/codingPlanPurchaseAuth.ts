/**
 * zcode 照搬：`@/settings/model-provider-section/codingPlanPurchaseAuth.ts`（references/zcode/packages/ui/src/settings/model-provider-section/codingPlanPurchaseAuth.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import { isCodingPlanModelProviderId } from "@zui/lib/zcode-shared";
import type { CodingPlanProviderId } from "@zui/settings/model-provider-section/constants";

type CodingPlanPurchaseAuthStatus =
  | "unknown"
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "error";

export function isCodingPlanPurchaseAuthPending(
  status: CodingPlanPurchaseAuthStatus,
): boolean {
  return status === "unknown" || status === "loading";
}

export function normalizeCodingPlanProviderId(
  providerId: string | null | undefined,
): CodingPlanProviderId | null {
  const normalized = providerId?.trim();
  return normalized && isCodingPlanModelProviderId(normalized)
    ? (normalized as CodingPlanProviderId)
    : null;
}

export function isCodingPlanProviderId(
  providerId: CodingPlanProviderId | null,
): providerId is CodingPlanProviderId {
  return Boolean(providerId);
}
