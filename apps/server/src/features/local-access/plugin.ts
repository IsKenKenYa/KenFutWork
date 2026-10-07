import type { PluginDefinition } from "../../kernel/types.js";
import { registerLocalHttpLifecycle } from "./http-lifecycle.js";
import { registerLocalAccessRoutes } from "./routes.js";
import { createLocalAccessService, isLoopbackAddress } from "./service.js";
import { createLocalAccessStore } from "./store.js";

export function createLocalAccessPlugin(): PluginDefinition {
  return {
    name: "local-access",
    inject: ["persistence", "localInstance", "settings"],
    apply(ctx) {
      if (
        ctx.env.serverHost !== "localhost" &&
        !isLoopbackAddress(ctx.env.serverHost)
      ) {
        throw new Error(
          "本期本地实例只允许回环监听；局域网配对将在独立阶段交付。",
        );
      }
      ctx.register("localAccess", () =>
        createLocalAccessService({
          store: createLocalAccessStore(ctx.get("persistence")),
          instance: ctx.get("localInstance"),
          allowedOrigins: () => {
            const address = ctx.app.server.address();
            const port =
              address && typeof address !== "string"
                ? address.port
                : ctx.env.port;
            return [
              ctx.env.webOrigin,
              ...["localhost", "127.0.0.1", "[::1]"].map(
                (host) => `http://${host}:${port}`,
              ),
            ];
          },
          readGovernance: async () => {
            const actor = await ctx.get("localInstance").serviceActor();
            const settings = await ctx
              .get("settings")
              .getInstanceSettings(actor, actor.instanceId);
            return {
              ticketTtlMs: settings.localAccessTicketTtlMs,
              sessionMaxAgeMs: settings.localAccessSessionMaxAgeMs,
            };
          },
        }),
      );
    },
    mounted(ctx) {
      registerLocalHttpLifecycle(ctx.app);
      ctx.app.addHook("onRequest", async (request, reply) => {
        const pathname = request.url.split("?", 1)[0];
        if (
          request.method === "OPTIONS" ||
          !pathname?.startsWith("/api/") ||
          pathname === "/api/health" ||
          pathname === "/api/local-access/connect"
        )
          return;
        const actor = await ctx.get("localAccess").authenticate(request);
        if (!actor)
          return reply.code(401).send({
            error: {
              code: "unauthorized",
              message: "本机连接凭据缺失或无效，请从桌面重新连接。",
            },
          });
      });
      ctx.app.addHook("onReady", async () => {
        await ctx.get("localAccess").initialize();
      });
    },
  };
}

export function createLocalAccessRoutesPlugin(): PluginDefinition {
  return {
    name: "local-access:http",
    inject: ["localAccess"],
    apply() {},
    mounted(ctx) {
      registerLocalAccessRoutes(ctx.app, {
        localAccessService: ctx.get("localAccess"),
      });
    },
  };
}
