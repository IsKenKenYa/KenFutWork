import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { LoomicAgentFactory } from "./agent/deep-agent.js";
import { loadServerEnv, type ServerEnv } from "./config/env.js";
import { registerAllProviders } from "./generation/providers/register-all.js";
import { registerCorsHook } from "./http/cors.js";
import { registerInfraRoutes } from "./http/infra.js";
import { registerPluginMarketRoutes } from "./http/plugin-market.js";
import { composePlugins } from "./kernel/compose.js";
import { AgentRunEventBus, createKernelEvents } from "./kernel/context.js";
import type { ServiceMap } from "./kernel/types.js";
import { serverProfile } from "./profiles/server.js";
import { createAdminSupabaseClient } from "./supabase/admin.js";
import { createUserSupabaseClientFactory } from "./supabase/user.js";
import { ConnectionManager } from "./ws/connection-manager.js";
import { CanvasEventBuffer } from "./ws/event-buffer.js";
import { registerWsRoute } from "./ws/handler.js";

/** app.ts（P8 退役形态）：选 profile → composePlugins；清单属主 profiles/server.ts。 */
export type AppOptions = {
  env?: Partial<ServerEnv>;
  agentFactory?: LoomicAgentFactory;
  agentModel?: string;
  mockEventDelayMs?: number;
  connectionManager?: ConnectionManager;
  overrides?: Partial<ServiceMap>;
  dump?: boolean;
};

function getLazyAdminClient(env: ServerEnv) {
  let admin: ReturnType<typeof createAdminSupabaseClient> | undefined;
  return () => (admin ??= createAdminSupabaseClient(env));
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const env = loadServerEnv(options.env);
  registerAllProviders(env);

  const app = Fastify({ logger: { level: "info" } });
  void app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  registerCorsHook(app, env.webOrigin);

  const connectionManager =
    options.connectionManager ?? new ConnectionManager();
  const eventBuffer = new CanvasEventBuffer();
  setInterval(() => eventBuffer.cleanup(), 5 * 60 * 1000);
  const eventBus = new AgentRunEventBus();

  const kernel = composePlugins(
    env,
    serverProfile({
      createUserClient: createUserSupabaseClientFactory(env),
      getAdminClient: getLazyAdminClient(env),
      connectionManager,
      events: createKernelEvents(eventBus),
      credentialEnv: env,
      env,
      ...(options.agentFactory ? { agentFactory: options.agentFactory } : {}),
      ...(options.agentModel ? { agentModel: options.agentModel } : {}),
      ...(options.mockEventDelayMs === undefined
        ? {}
        : { mockEventDelayMs: options.mockEventDelayMs }),
      ...(options.overrides?.jobs
        ? { overrideJobs: options.overrides.jobs }
        : {}),
      ...(options.overrides?.payments
        ? { overridePayments: options.overrides.payments }
        : {}),
    }),
    {
      app,
      events: eventBus,
      ...(options.dump || process.env.LOOMIC_DUMP_CONFIG === "1"
        ? { dump: true }
        : {}),
      overrides: options.overrides ?? {},
    },
  );

  void app.register(async (instance) => {
    await instance.register(websocket);
    await registerWsRoute(instance, {
      agentRuns: kernel.get("agentRuns"),
      agentRunMetadataService: kernel.get("agentRunMetadata"),
      auth: kernel.get("auth"),
      chatService: kernel.get("chat"),
      connectionManager,
      eventBuffer,
      settingsService: kernel.get("settings"),
      threadService: kernel.get("threads"),
      viewerService: kernel.get("viewer"),
    });
  });

  registerInfraRoutes(app, env);
  registerPluginMarketRoutes(app);

  return app;
}
