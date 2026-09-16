// @credits-system — Payment lifecycle: checkout creation, subscription sync, cancellation, plan changes
import type { BillingPeriod, SubscriptionPlan } from "@kenfutwork/shared";
import { PLAN_CONFIGS } from "@kenfutwork/shared";

import type { LemonSqueezyClient } from "./lemon-squeezy-client.js";
import type { PaymentRepository, SubscriptionPatch } from "./repository.js";

// ── Error ────────────────────────────────────────────────────

export class PaymentServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "payment_not_configured"
    | "variant_not_found"
    | "checkout_failed"
    | "subscription_not_found"
    | "subscription_update_failed"
    | "webhook_processing_failed";

  constructor(
    code: PaymentServiceError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "PaymentServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Types ────────────────────────────────────────────────────

export type SubscriptionStatus = {
  plan: SubscriptionPlan;
  billingPeriod: BillingPeriod | null;
  status: string | null;
  lemonSqueezySubscriptionId: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
  customerPortalUrl: string | null;
};

export type VariantMap = Record<string, string>;

export type PaymentService = {
  createCheckout(
    workspaceId: string,
    planId: SubscriptionPlan,
    billingPeriod: BillingPeriod,
  ): Promise<{ checkoutUrl: string }>;

  handleWebhookEvent(eventName: string, payload: WebhookPayload): Promise<void>;

  getSubscriptionStatus(workspaceId: string): Promise<SubscriptionStatus>;

  cancelSubscription(workspaceId: string): Promise<void>;

  changePlan(
    workspaceId: string,
    newPlanId: SubscriptionPlan,
    billingPeriod: BillingPeriod,
  ): Promise<void>;
};

export type WebhookPayload = {
  meta: {
    event_name: string;
    custom_data?: { workspace_id?: string };
  };
  data: {
    id: string;
    type: string;
    attributes: {
      store_id: number;
      customer_id: number;
      order_id: number;
      variant_id: number;
      status: string;
      renews_at: string | null;
      ends_at: string | null;
      cancelled?: boolean;
      urls?: {
        customer_portal?: string;
        update_payment_method?: string;
      };
      [key: string]: unknown;
    };
  };
};

// ── Factory ──────────────────────────────────────────────────

export function createPaymentService(options: {
  lemonSqueezy: LemonSqueezyClient;
  repository: PaymentRepository;
  variantMap: VariantMap;
  webOrigin: string;
}): PaymentService {
  const { lemonSqueezy, repository, variantMap, webOrigin } = options;

  // Build reverse lookup: variantId -> "plan_period"
  const reverseVariantMap = new Map<
    string,
    { plan: SubscriptionPlan; period: BillingPeriod }
  >();
  for (const [key, variantId] of Object.entries(variantMap)) {
    if (!variantId) continue;
    const [plan, period] = key.split("_") as [SubscriptionPlan, BillingPeriod];
    reverseVariantMap.set(variantId, { plan, period });
  }

  function lookupVariant(
    planId: SubscriptionPlan,
    billingPeriod: BillingPeriod,
  ): string {
    const key = `${planId}_${billingPeriod}`;
    const variantId = variantMap[key];
    if (!variantId) {
      throw new PaymentServiceError(
        "variant_not_found",
        `No Lemon Squeezy variant configured for ${key}. Set the corresponding LEMONSQUEEZY_VARIANT env var.`,
        400,
      );
    }
    return variantId;
  }

  function resolvePlanFromVariant(
    variantId: number,
  ): { plan: SubscriptionPlan; period: BillingPeriod } | null {
    return reverseVariantMap.get(String(variantId)) ?? null;
  }

  return {
    async createCheckout(workspaceId, planId, billingPeriod) {
      const variantId = lookupVariant(planId, billingPeriod);
      const redirectUrl = `${webOrigin}/settings?checkout=success`;

      const result = await lemonSqueezy.createCheckout(
        variantId,
        workspaceId,
        redirectUrl,
      );

      return { checkoutUrl: result.checkoutUrl };
    },

    async handleWebhookEvent(eventName, payload) {
      const workspaceId = payload.meta.custom_data?.workspace_id;
      const attrs = payload.data.attributes;
      const subscriptionId = payload.data.id;

      switch (eventName) {
        case "subscription_created": {
          if (!workspaceId) {
            console.warn(
              "[PaymentService] subscription_created missing workspace_id in custom_data",
            );
            return;
          }

          const resolved = resolvePlanFromVariant(attrs.variant_id);
          const plan: SubscriptionPlan = resolved?.plan ?? "starter";
          const billingPeriod: BillingPeriod = resolved?.period ?? "monthly";

          await repository.updateSubscriptionByWorkspace(workspaceId, {
            plan,
            billing_period: billingPeriod,
            lemon_squeezy_subscription_id: subscriptionId,
            lemon_squeezy_customer_id: String(attrs.customer_id),
            lemon_squeezy_variant_id: String(attrs.variant_id),
            lemon_squeezy_order_id: String(attrs.order_id),
            current_period_end: attrs.renews_at ?? null,
            canceled_at: null,
          });

          // Credits are granted by the subscription_payment_success event
          // which always fires alongside subscription_created on initial purchase.
          break;
        }

        case "subscription_updated": {
          // Find workspace by LS subscription ID
          const wsId =
            workspaceId ??
            (await repository.findWorkspaceIdByLsSubscriptionId(
              subscriptionId,
            ));
          if (!wsId) {
            console.warn(
              "[PaymentService] subscription_updated: cannot resolve workspace",
            );
            return;
          }

          const resolved = resolvePlanFromVariant(attrs.variant_id);
          const updateData: SubscriptionPatch = {
            lemon_squeezy_variant_id: String(attrs.variant_id),
            current_period_end: attrs.renews_at ?? null,
          };

          if (resolved) {
            updateData.plan = resolved.plan;
            updateData.billing_period = resolved.period;
          }

          if (attrs.cancelled === true && attrs.ends_at) {
            updateData.canceled_at = attrs.ends_at;
          } else if (attrs.status === "active" && !attrs.cancelled) {
            // Subscription resumed or un-cancelled
            updateData.canceled_at = null;
          }

          await repository.updateSubscriptionByWorkspace(wsId, updateData);

          // If plan changed (upgrade/downgrade), grant credits difference
          if (resolved) {
            await grantMonthlyCredits(repository, wsId, resolved.plan);
          }
          break;
        }

        case "subscription_cancelled": {
          const wsId =
            workspaceId ??
            (await repository.findWorkspaceIdByLsSubscriptionId(
              subscriptionId,
            ));
          if (!wsId) {
            console.warn(
              "[PaymentService] subscription_cancelled: cannot resolve workspace",
            );
            return;
          }

          // Mark as cancelled but keep plan active until period end
          await repository.updateSubscriptionByWorkspace(wsId, {
            canceled_at: attrs.ends_at ?? new Date().toISOString(),
          });
          break;
        }

        case "subscription_payment_success": {
          const wsId =
            workspaceId ??
            (await repository.findWorkspaceIdByLsSubscriptionId(
              subscriptionId,
            ));
          if (!wsId) {
            console.warn(
              "[PaymentService] subscription_payment_success: cannot resolve workspace",
            );
            return;
          }

          // Get current plan for the workspace
          const sub = await repository.findSubscriptionByWorkspace(wsId);

          if (sub) {
            // Update renewal period
            await repository.updateSubscriptionByWorkspace(wsId, {
              current_period_end: attrs.renews_at ?? null,
              canceled_at: null,
            });

            // Grant monthly credits for renewal
            const plan = sub.plan as SubscriptionPlan;
            await grantMonthlyCredits(repository, wsId, plan);
          }
          break;
        }

        case "subscription_payment_failed": {
          const wsId =
            workspaceId ??
            (await repository.findWorkspaceIdByLsSubscriptionId(
              subscriptionId,
            ));
          console.warn(
            `[PaymentService] Payment failed for workspace=${wsId ?? "unknown"} subscription=${subscriptionId}`,
          );
          break;
        }

        case "subscription_expired": {
          const wsId =
            workspaceId ??
            (await repository.findWorkspaceIdByLsSubscriptionId(
              subscriptionId,
            ));
          if (!wsId) {
            console.warn(
              "[PaymentService] subscription_expired: cannot resolve workspace",
            );
            return;
          }

          // Downgrade to free plan
          await repository.updateSubscriptionByWorkspace(wsId, {
            plan: "free",
            billing_period: null,
            lemon_squeezy_subscription_id: null,
            lemon_squeezy_customer_id: null,
            lemon_squeezy_variant_id: null,
            lemon_squeezy_order_id: null,
            current_period_end: null,
            canceled_at: null,
          });
          break;
        }

        default:
          console.log(`[PaymentService] Unhandled webhook event: ${eventName}`);
      }
    },

    async getSubscriptionStatus(workspaceId) {
      const data = await repository
        .findSubscriptionByWorkspace(workspaceId)
        .catch(() => {
          throw new PaymentServiceError(
            "subscription_not_found",
            "Failed to query subscription.",
            500,
          );
        });

      // If there is a LS subscription, fetch portal URL from the API
      let customerPortalUrl: string | null = null;
      const lsSubId = data?.lemon_squeezy_subscription_id ?? null;
      if (lsSubId) {
        try {
          const lsSub = await lemonSqueezy.getSubscription(lsSubId);
          customerPortalUrl = lsSub.attributes.urls.customer_portal ?? null;
        } catch {
          // Non-critical — we can still return status without the portal URL
        }
      }

      return {
        plan: (data?.plan as SubscriptionPlan) ?? "free",
        billingPeriod: (data?.billing_period as BillingPeriod) ?? null,
        status: lsSubId ? "active" : null,
        lemonSqueezySubscriptionId: lsSubId ?? null,
        currentPeriodEnd: data?.current_period_end ?? null,
        canceledAt: data?.canceled_at ?? null,
        customerPortalUrl,
      };
    },

    async cancelSubscription(workspaceId) {
      const data = await repository
        .findSubscriptionByWorkspace(workspaceId)
        .catch(() => null);

      const lsSubId = data?.lemon_squeezy_subscription_id ?? null;
      if (!lsSubId) {
        throw new PaymentServiceError(
          "subscription_not_found",
          "No active Lemon Squeezy subscription found for this workspace.",
          404,
        );
      }

      // Cancel at period end via the LS API
      await lemonSqueezy.cancelSubscription(lsSubId);

      // The webhook will update canceled_at, but we can set it optimistically
      // (the webhook handler also handles this, so it's idempotent)
    },

    async changePlan(workspaceId, newPlanId, billingPeriod) {
      const data = await repository
        .findSubscriptionByWorkspace(workspaceId)
        .catch(() => null);

      const lsSubId = data?.lemon_squeezy_subscription_id ?? null;
      if (!lsSubId) {
        throw new PaymentServiceError(
          "subscription_not_found",
          "No active Lemon Squeezy subscription found for this workspace.",
          404,
        );
      }

      const newVariantId = lookupVariant(newPlanId, billingPeriod);

      await lemonSqueezy.updateSubscription(lsSubId, {
        variant_id: parseInt(newVariantId, 10),
        invoice_immediately: true,
      });

      // The webhook (subscription_updated) will handle the DB update
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────

/** 发月度额度：余额与流水的原子性由 repository 的事务 + 行锁保证。 */
async function grantMonthlyCredits(
  repository: PaymentRepository,
  workspaceId: string,
  plan: SubscriptionPlan,
): Promise<void> {
  const config = PLAN_CONFIGS[plan];
  if (config.monthlyCredits <= 0) return;

  await repository.grantMonthlyCredits({
    amount: config.monthlyCredits,
    description: `${plan} plan — monthly credits granted`,
    workspaceId,
  });
}

export function buildVariantMap(env: {
  lemonSqueezyVariantStarterMonthly?: string;
  lemonSqueezyVariantStarterYearly?: string;
  lemonSqueezyVariantProMonthly?: string;
  lemonSqueezyVariantProYearly?: string;
  lemonSqueezyVariantUltraMonthly?: string;
  lemonSqueezyVariantUltraYearly?: string;
  lemonSqueezyVariantBusinessMonthly?: string;
  lemonSqueezyVariantBusinessYearly?: string;
}): VariantMap {
  const map: VariantMap = {};
  if (env.lemonSqueezyVariantStarterMonthly)
    map.starter_monthly = env.lemonSqueezyVariantStarterMonthly;
  if (env.lemonSqueezyVariantStarterYearly)
    map.starter_yearly = env.lemonSqueezyVariantStarterYearly;
  if (env.lemonSqueezyVariantProMonthly)
    map.pro_monthly = env.lemonSqueezyVariantProMonthly;
  if (env.lemonSqueezyVariantProYearly)
    map.pro_yearly = env.lemonSqueezyVariantProYearly;
  if (env.lemonSqueezyVariantUltraMonthly)
    map.ultra_monthly = env.lemonSqueezyVariantUltraMonthly;
  if (env.lemonSqueezyVariantUltraYearly)
    map.ultra_yearly = env.lemonSqueezyVariantUltraYearly;
  if (env.lemonSqueezyVariantBusinessMonthly)
    map.business_monthly = env.lemonSqueezyVariantBusinessMonthly;
  if (env.lemonSqueezyVariantBusinessYearly)
    map.business_yearly = env.lemonSqueezyVariantBusinessYearly;
  return map;
}
