// @credits-system — Tier enforcement: model access, resolution limits, concurrency guards per plan
import type {
  BackgroundJobType,
  BillingErrorCode,
  ImageQualityLevel,
  SubscriptionPlan,
  VideoResolution,
} from "@kenfutwork/shared";
import {
  canAccessModel,
  canUseResolution,
  canUseVideoResolution,
  getImageCreditCost,
  getVideoCreditCost,
  PLAN_CONFIGS,
} from "@kenfutwork/shared";

// ── Error ────────────────────────────────────────────────────

export type TierGuardErrorCode = Exclude<
  BillingErrorCode,
  "insufficient_credits"
>;

export class TierGuardError extends Error {
  readonly statusCode: number;
  readonly code: TierGuardErrorCode;

  constructor(
    code: TierGuardError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "TierGuardError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Types ────────────────────────────────────────────────────

export type TierGuard = {
  checkModelAccess(plan: SubscriptionPlan, modelId: string): void;
  checkResolution(plan: SubscriptionPlan, quality: ImageQualityLevel): void;
  checkVideoResolution(
    plan: SubscriptionPlan,
    resolution: VideoResolution,
  ): void;
  checkConcurrency(workspaceId: string, plan: SubscriptionPlan): Promise<void>;
  calculateCreditCost(
    modelId: string,
    jobType: BackgroundJobType,
    params?: {
      quality?: ImageQualityLevel;
      duration?: number;
      resolution?: VideoResolution;
    },
  ): number;
};

// ── Factory ──────────────────────────────────────────────────

export function createTierGuard(options: {
  /** 并发检查所需的工作区进行中任务数（数据访问归 jobs 聚合）。 */
  countActiveJobs: (workspaceId: string) => Promise<number>;
}): TierGuard {
  return {
    checkModelAccess(plan, modelId) {
      if (!canAccessModel(plan, modelId)) {
        throw new TierGuardError(
          "model_not_accessible",
          `Your ${plan} plan does not have access to model "${modelId}". Please upgrade your plan.`,
          403,
        );
      }
    },

    checkResolution(plan, quality) {
      if (!canUseResolution(plan, quality)) {
        throw new TierGuardError(
          "resolution_not_allowed",
          `Your ${plan} plan does not allow "${quality}" image quality. Maximum allowed: "${PLAN_CONFIGS[plan].maxResolution}". Please upgrade your plan.`,
          403,
        );
      }
    },

    checkVideoResolution(plan, resolution) {
      if (!canUseVideoResolution(plan, resolution)) {
        throw new TierGuardError(
          "resolution_not_allowed",
          `Your ${plan} plan does not allow "${resolution}" video resolution. Maximum allowed: "${PLAN_CONFIGS[plan].maxVideoResolution}". Please upgrade your plan.`,
          403,
        );
      }
    },

    async checkConcurrency(workspaceId, plan) {
      const maxConcurrent = PLAN_CONFIGS[plan].maxConcurrentJobs;

      let activeCount: number;
      try {
        activeCount = await options.countActiveJobs(workspaceId);
      } catch (error) {
        // Log but don't block — fail open on query errors（与旧行为一致）
        console.error(
          "[tier-guard] Failed to check concurrency:",
          error instanceof Error ? error.message : error,
        );
        return;
      }

      if (activeCount >= maxConcurrent) {
        throw new TierGuardError(
          "concurrency_limit",
          `Concurrent job limit reached (${activeCount}/${maxConcurrent}). Wait for a job to finish or upgrade your plan.`,
          429,
        );
      }
    },

    calculateCreditCost(modelId, jobType, params) {
      if (jobType === "image_generation") {
        const quality: ImageQualityLevel = params?.quality ?? "hd";
        return getImageCreditCost(modelId, quality);
      }
      // video_generation
      return getVideoCreditCost(modelId, params?.duration, params?.resolution);
    },
  };
}
