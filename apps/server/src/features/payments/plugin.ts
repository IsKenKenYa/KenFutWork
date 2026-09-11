import { registerPaymentRoutes } from "../../http/payments.js";
import { registerPaymentWebhookRoute } from "../../http/payments-webhook.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createLemonSqueezyClient } from "./lemon-squeezy-client.js";
import type { PaymentService } from "./payment-service.js";
import { buildVariantMap, createPaymentService } from "./payment-service.js";

/**
 * payments 插件：Lemon Squeezy 支付服务 + 支付/webhook 路由。
 * enabled 判定：配置齐全（apiKey + storeId）或注入实例时装配，misconfiguration 不静默。
 * 注入 injected（原 BuildAppOptions.paymentService）时无条件启用，保持历史行为。
 * DEC-5：目标态（桌面/自托管）默认关闭；迁移期保持现状行为不变。
 */
export function createPaymentsPlugin(deps: {
  getAdminClient: () => AdminSupabaseClient;
  injected?: PaymentService | undefined;
}): PluginDefinition {
  return {
    name: "payments",
    inject: ["auth", "viewer"],
    enabled: (env) =>
      Boolean(
        deps.injected || (env.lemonSqueezyApiKey && env.lemonSqueezyStoreId),
      ),
    apply(ctx) {
      ctx.register("payments", () =>
        createPaymentService({
          lemonSqueezy: createLemonSqueezyClient({
            apiKey: ctx.env.lemonSqueezyApiKey as string,
            storeId: ctx.env.lemonSqueezyStoreId as string,
          }),
          getAdminClient: deps.getAdminClient,
          variantMap: buildVariantMap(ctx.env),
          webOrigin: ctx.env.webOrigin,
        }),
      );
    },
    mounted(ctx) {
      const paymentService = ctx.get("payments");
      void registerPaymentRoutes(ctx.app, {
        auth: ctx.get("auth"),
        paymentService,
        viewerService: ctx.get("viewer"),
      });

      if (ctx.env.lemonSqueezyWebhookSecret) {
        // Webhook 路由注册在封装作用域内，自定义 content-type parser 不外泄。
        void ctx.app.register(async (webhookScope) => {
          await registerPaymentWebhookRoute(webhookScope, {
            getAdminClient: deps.getAdminClient,
            paymentService,
            webhookSecret: ctx.env.lemonSqueezyWebhookSecret as string,
          });
        });
      }
    },
  };
}
