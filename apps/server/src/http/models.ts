import { type ModelInfo, modelListResponseSchema } from "@loomic/shared";
import type { FastifyInstance } from "fastify";

import type { ServerEnv } from "../config/env.js";
import {
  type ModelCatalogService,
  toInstanceSpecifier,
} from "../features/model-providers/model-catalog-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const OPENAI_MODELS: ModelInfo[] = [
  { id: "openai:az_sre/gpt-5.4", name: "GPT-5.4", provider: "openai" },
  { id: "openai:gpt-5.4", name: "OpenAI GPT-5.4", provider: "openai" },
  { id: "openai:gpt-5.2", name: "OpenAI GPT-5.2", provider: "openai" },
  { id: "openai:gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" },
  { id: "openai:gpt-4.1", name: "GPT-4.1", provider: "openai" },
  { id: "openai:gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "openai:gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
  { id: "openai:o3-mini", name: "o3 Mini", provider: "openai" },
];

const GOOGLE_MODELS: ModelInfo[] = [
  // Gemini 3 series (Preview)
  {
    id: "google:gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    provider: "google",
  },
  {
    id: "google:gemini-3-flash-preview",
    name: "Gemini 3 Flash",
    provider: "google",
  },
  {
    id: "google:gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite",
    provider: "google",
  },
  // Gemini 2.5 series (GA)
  { id: "google:gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
  {
    id: "google:gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
  },
  {
    id: "google:gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    provider: "google",
  },
];

export async function registerModelRoutes(
  app: FastifyInstance,
  options: {
    env: ServerEnv;
    auth: RequestAuthenticator;
    modelCatalog?: ModelCatalogService;
  },
) {
  const { env } = options;
  app.get("/api/models", async (request, reply) => {
    const models: ModelInfo[] = [];
    if (env.openAIApiKey) models.push(...OPENAI_MODELS);
    if (env.googleApiKey || env.googleVertexProject)
      models.push(...GOOGLE_MODELS);

    // P5：并入用户供应商实例目录（BYOK，specifier = <instanceId>:<model>）。
    // 目录读取失败不阻断内置目录返回（降级为内置于预）。
    if (options.modelCatalog) {
      try {
        const user = await options.auth.authenticate(request);
        if (user) {
          const entries = await options.modelCatalog.listCatalog(user);
          models.push(
            ...entries
              .filter((entry) => entry.capability === "chat")
              .map((entry) => ({
                id: toInstanceSpecifier(entry),
                name: entry.name,
                provider: entry.provider.instanceId,
                providerName: entry.provider.name,
                ...(entry.model.vision ? { vision: true } : {}),
                ...(entry.model.contextWindow
                  ? { contextWindow: entry.model.contextWindow }
                  : {}),
              })),
          );
        }
      } catch (error) {
        console.warn("[models] instance catalog merge failed:", error);
      }
    }

    return reply.code(200).send(modelListResponseSchema.parse({ models }));
  });
}
