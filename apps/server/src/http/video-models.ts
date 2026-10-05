// BYOK — Video model list from the user's provider instances（2026-09-18 起内置
// 目录/遗留 env 注册退役，模型清单来自用户实例目录；specifier = <instanceId>:<model>）。

import type { FastifyInstance } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { ModelCatalogService } from "../features/model-providers/model-catalog-service.js";
import { toInstanceSpecifier } from "../features/model-providers/model-catalog-service.js";

export async function registerVideoModelRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    modelCatalog: ModelCatalogService;
  },
) {
  app.get("/api/video-models", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
    if (!user) {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "Missing or invalid bearer token.",
        },
      });
    }

    const entries = (await options.modelCatalog.listCatalog(user)).filter(
      (entry) => entry.capability === "video",
    );

    const models = entries.map((entry) => ({
      id: toInstanceSpecifier(entry),
      displayName: entry.name,
      description: `${entry.name}（实例：${entry.provider.name}）`,
      iconUrl: undefined,
      provider: entry.provider.name,
      // 平台池（scope=system）的计费在生成路径按套餐结算；自带实例不进注解表
      accessible: true,
      creditCost: 0,
      minTier: "free" as const,
      capabilities: {
        textToVideo: true,
        imageToVideo: false,
        videoToVideo: false,
        audio: false,
      },
      limits: {
        maxDuration: 15,
        maxResolution: "1080p" as const,
        maxInputImages: 4,
      },
      pricing: undefined,
    }));

    return reply.code(200).send({ models });
  });
}
