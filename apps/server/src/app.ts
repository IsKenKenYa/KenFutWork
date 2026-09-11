import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { LoomicAgentFactory } from "./agent/deep-agent.js";
import {
  type AgentPersistenceService,
  createAgentPersistenceService,
} from "./agent/persistence/index.js";
import { createAgentRunService } from "./agent/runtime.js";
import {
  loadServerEnv,
  resolveDefaultAgentModel,
  type ServerEnv,
} from "./config/env.js";
import {
  type AgentRunMetadataService,
  createAgentRunMetadataService,
} from "./features/agent-runs/agent-run-service.js";
import { createViewerPlugin } from "./features/bootstrap/plugin.js";
import { brandKitPlugin } from "./features/brand-kit/plugin.js";
import { createCanvasPlugin } from "./features/canvas/plugin.js";
import { createChatPlugin } from "./features/chat/plugin.js";
import { createCreditsPlugin } from "./features/credits/plugin.js";
import { createJobsPlugin } from "./features/jobs/plugin.js";
import { createPaymentsPlugin } from "./features/payments/plugin.js";
import { createProjectsPlugin } from "./features/projects/plugin.js";
import { createSettingsPlugin } from "./features/settings/plugin.js";
import { createUploadsPlugin } from "./features/uploads/plugin.js";
import { registerAllProviders } from "./generation/providers/register-all.js";
import { registerFontsRoutes } from "./http/fonts.js";
import { registerGenerateRoutes } from "./http/generate.js";
import { registerHealthRoutes } from "./http/health.js";
import { registerImageModelRoutes } from "./http/image-models.js";
import { registerImageProxyRoute } from "./http/image-proxy.js";
import { registerModelRoutes } from "./http/models.js";
import { registerRunRoutes } from "./http/runs.js";
import { registerSkillRoutes } from "./http/skills.js";
import { registerMarketplaceRoutes } from "./http/skills-marketplace.js";
import { registerVideoModelRoutes } from "./http/video-models.js";
import { composePlugins } from "./kernel/compose.js";
import type { KernelHandle, ServiceMap } from "./kernel/types.js";
import { createAdminSupabaseClient } from "./supabase/admin.js";
import {
  createSupabaseRequestAuthenticator,
  createUserSupabaseClientFactory,
  type RequestAuthenticator,
} from "./supabase/user.js";
import { ConnectionManager } from "./ws/connection-manager.js";
import { CanvasEventBuffer } from "./ws/event-buffer.js";
import { registerWsRoute } from "./ws/handler.js";

export type BuildAppOptions = {
  agentFactory?: LoomicAgentFactory;
  agentModel?: BaseLanguageModel | string;
  agentPersistenceService?: AgentPersistenceService;
  agentRunMetadataService?: AgentRunMetadataService;
  auth?: RequestAuthenticator;
  connectionManager?: ConnectionManager;
  env?: Partial<ServerEnv>;
  mockEventDelayMs?: number;
  /**
   * 内核服务直填（插件化改造过渡期收编 BuildAppOptions 逐项服务注入，P2 起）。
   * 命中 overrides 的 key 跳过对应插件工厂，语义与旧的单项可选字段一致。
   */
  overrides?: Partial<ServiceMap>;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = loadServerEnv(options.env);

  // Register generation providers (shared with worker.ts)
  registerAllProviders(env);

  const app = Fastify({
    logger: { level: "info" },
  });
  void app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });
  void app.register(async (instance) => {
    await instance.register(websocket);
    await registerWsRoute(instance, {
      agentRuns,
      agentRunMetadataService,
      auth,
      chatService,
      connectionManager,
      eventBuffer,
      settingsService,
      threadService,
      viewerService,
    });
  });
  const auth = options.auth ?? createSupabaseRequestAuthenticator(env);
  const createUserClient = createUserSupabaseClientFactory(env);
  let adminClient: ReturnType<typeof createAdminSupabaseClient> | undefined;
  const getAdminClient = () => {
    adminClient ??= createAdminSupabaseClient(env);
    return adminClient;
  };
  // 插件化改造（P2 起）：已迁移 feature 走内核装配；其余仍为手工装配，P3 逐个迁移。
  const kernel: KernelHandle = composePlugins(
    env,
    [
      brandKitPlugin,
      createCreditsPlugin({ getAdminClient }),
      createViewerPlugin({ getAdminClient }),
      createCanvasPlugin({ createUserClient }),
      createChatPlugin({ createUserClient }),
      createSettingsPlugin({ createUserClient }),
      createUploadsPlugin({ createUserClient }),
      createProjectsPlugin({ createUserClient }),
    ],
    {
      app,
      overrides: {
        auth,
        ...(options.overrides ?? {}),
      },
    },
  );
  const viewerService = kernel.get("viewer");
  const creditService = kernel.get("credits");
  const tierGuard = kernel.get("tierGuard");
  const threadService = kernel.get("threads");
  const chatService = kernel.get("chat");
  const agentRunMetadataService =
    options.agentRunMetadataService ??
    createAgentRunMetadataService({ getAdminClient });
  const agentPersistenceService =
    options.agentPersistenceService ?? createAgentPersistenceService(env);
  const settingsService = kernel.get("settings");
  const uploadService = kernel.get("uploads");
  const jobService = kernel.tryGet("jobs");

  const connectionManager =
    options.connectionManager ?? new ConnectionManager();
  const eventBuffer = new CanvasEventBuffer();
  setInterval(() => eventBuffer.cleanup(), 5 * 60 * 1000);
  const agentRuns = createAgentRunService({
    agentPersistenceService,
    ...(options.agentFactory ? { agentFactory: options.agentFactory } : {}),
    agentRunMetadataService,
    connectionManager,
    createUserClient,
    ...(options.agentModel ? { model: options.agentModel } : {}),
    ...(options.mockEventDelayMs === undefined
      ? {}
      : { eventDelayMs: options.mockEventDelayMs }),
    env,
    ...(jobService ? { jobService } : {}),
    creditService,
    tierGuard,
    viewerService,
  });

  app.addHook("onRequest", async (request, reply) => {
    const corsResult = evaluateCors(request, env.webOrigin);

    if (!corsResult.allowed) {
      return reply.code(403).send({
        message: "Origin not allowed",
      });
    }

    if (corsResult.allowOrigin) {
      reply.header("access-control-allow-origin", corsResult.allowOrigin);
      reply.header("vary", "Origin");
    }

    if (corsResult.isBrowserRequest) {
      reply.header(
        "access-control-allow-methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
      reply.header(
        "access-control-allow-headers",
        resolveAllowedHeaders(
          request.headers["access-control-request-headers"],
        ),
      );
    }

    if (corsResult.isPreflight) {
      return reply.code(204).send();
    }
  });

  void registerHealthRoutes(app, env);
  void registerFontsRoutes(app, { env });
  void registerImageProxyRoute(app);
  void registerRunRoutes(app, agentRuns, {
    agentRunMetadataService,
    auth,
    settingsService,
    threadService,
    viewerService,
  });
  void registerModelRoutes(app, env);
  void registerImageModelRoutes(app, { auth, creditService, viewerService });
  void registerVideoModelRoutes(app, { auth, creditService, viewerService });
  void registerGenerateRoutes(app, {
    auth,
    creditService,
    uploadService,
    viewerService,
    ...(jobService ? { jobService } : {}),
    ...(tierGuard ? { tierGuard } : {}),
  });
  void registerSkillRoutes(app, { auth, createUserClient, viewerService });
  void registerMarketplaceRoutes(app, {
    auth,
    createUserClient,
    viewerService,
  });

  return app;
}

type CorsResult = {
  allowed: boolean;
  allowOrigin: string | null;
  isBrowserRequest: boolean;
  isPreflight: boolean;
};

function evaluateCors(request: FastifyRequest, webOrigin: string): CorsResult {
  const origin = request.headers.origin;
  const isPreflight =
    request.method === "OPTIONS" &&
    typeof request.headers["access-control-request-method"] === "string";

  if (!origin) {
    return {
      allowed: true,
      allowOrigin: null,
      isBrowserRequest: false,
      isPreflight,
    };
  }

  if (origin === webOrigin) {
    return {
      allowed: true,
      allowOrigin: origin,
      isBrowserRequest: true,
      isPreflight,
    };
  }

  if (origin === "null" && isLoopbackHost(request.headers.host)) {
    return {
      allowed: true,
      allowOrigin: origin,
      isBrowserRequest: true,
      isPreflight,
    };
  }

  return {
    allowed: false,
    allowOrigin: null,
    isBrowserRequest: true,
    isPreflight,
  };
}

function resolveAllowedHeaders(requestHeaders: string | undefined) {
  return requestHeaders?.trim() || "Content-Type";
}

function isLoopbackHost(host: string | undefined) {
  if (!host) {
    return false;
  }

  if (host.startsWith("[")) {
    return host.startsWith("[::1]");
  }

  const [hostname] = host.split(":");
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  );
}
