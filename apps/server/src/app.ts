import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { LoomicAgentFactory } from "./agent/deep-agent.js";
import { loadServerEnv, type ServerEnv } from "./config/env.js";
import { registerAllProviders } from "./generation/providers/register-all.js";
import { registerCorsHook } from "./http/cors.js";
import { registerInfraRoutes } from "./http/infra.js";
import { registerStaticWebRoutes } from "./http/static-web.js";
import { composePlugins } from "./kernel/compose.js";
import { AgentRunEventBus, createKernelEvents } from "./kernel/context.js";
import type { KernelHandle, ServiceMap } from "./kernel/types.js";
import { serverProfile } from "./profiles/server.js";
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

export function buildApp(
  options: AppOptions = {},
): FastifyInstance & { kernel: KernelHandle } {
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
      agentModes: kernel.get("agentModes"),
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
  // 静态 UI 托管（自托管/桌面包）：配置 LOOMIC_WEB_DIST 后 server 直接托管前端
  if (env.webDist) {
    registerStaticWebRoutes(app, { distDir: env.webDist });
  }

  // HTTP 关闭即释放内核资源（连接池等 effect disposer）——否则停库时连接池还握着连接
  app.addHook("onClose", async () => {
    kernel.dispose();
  });

  // 内核句柄随 app 一起返回：桌面单进程形态要在同一内核上起任务消费循环
  // （进程内队列的生产者与消费者必须是同一个实例，M3.2）
  return Object.assign(app, { kernel });
}
