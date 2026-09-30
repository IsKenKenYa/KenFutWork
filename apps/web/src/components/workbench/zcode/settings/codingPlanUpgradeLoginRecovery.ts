/**
 * zcode 照搬：`@/settings/codingPlanUpgradeLoginRecovery.ts`（references/zcode/packages/ui/src/settings/codingPlanUpgradeLoginRecovery.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import type { OAuthProviderId } from "@zui/lib/zcode-shared";
import type { PurchaseAudience } from "@zui/settings/model-provider-section/codingPlanEnterpriseTiers";

export interface CodingPlanUpgradeDialogTarget {
  providerId: string;
  initialAudience?: PurchaseAudience;
  initialTeamPlanKey?: string;
  funnelContext?: import("@zui/lib/codingPlanFunnelTelemetry").CodingPlanFunnelContext;
}

interface PendingCodingPlanUpgradeAfterLogin {
  loginAttemptId: number;
  target: CodingPlanUpgradeDialogTarget;
}

export function beginCodingPlanUpgradeLogin(params: {
  target: CodingPlanUpgradeDialogTarget;
  oauthProviderId: OAuthProviderId;
  audience: PurchaseAudience;
  requestLoginEntry: (providerId?: OAuthProviderId) => number;
  onClose: () => void;
}): PendingCodingPlanUpgradeAfterLogin {
  const loginAttemptId = params.requestLoginEntry(params.oauthProviderId);
  const pending = {
    loginAttemptId,
    target: {
      ...params.target,
      initialAudience: params.audience,
    },
  };
  params.onClose();
  return pending;
}

export function resolvePendingCodingPlanUpgradeAfterLogin(params: {
  pending: PendingCodingPlanUpgradeAfterLogin | null;
  loginAttempt: {
    id: number;
    status: "requested" | "waiting" | "succeeded" | "cancelled" | "failed";
  } | null;
}):
  | { action: "wait" }
  | { action: "discard" }
  | { action: "reopen"; target: CodingPlanUpgradeDialogTarget } {
  if (!params.pending || !params.loginAttempt) {
    return { action: "wait" };
  }
  if (params.loginAttempt.id !== params.pending.loginAttemptId) {
    return { action: "discard" };
  }
  if (
    params.loginAttempt.status === "requested" ||
    params.loginAttempt.status === "waiting"
  ) {
    return { action: "wait" };
  }
  if (params.loginAttempt.status === "succeeded") {
    return { action: "reopen", target: params.pending.target };
  }
  return { action: "discard" };
}
