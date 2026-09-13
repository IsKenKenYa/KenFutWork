import {
  applicationErrorResponseSchema,
  type HomeLibraryResponse,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance } from "fastify";

import type { RequestAuthenticator } from "../features/auth/types.js";
import type { HomeService } from "../features/home/service.js";

/**
 * 首页库路由（Design 模式首页的示例/发现内容）。
 *
 *   GET /api/home/library   示例 + 发现 + 分类（素材 URL 已由服务端解析）
 *
 * 认证门与其它业务路由一致：内容本身不敏感，但工作台接口统一要求已登录。
 */
export async function registerHomeRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    parse: (payload: unknown) => HomeLibraryResponse;
    service: HomeService;
  },
): Promise<void> {
  app.get("/api/home/library", async (request, reply) => {
    const user = await options.auth.authenticate(request).catch(() => null);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: { code: "unauthenticated", message: "Unauthorized." },
        }),
      );
    }

    try {
      const library = await options.service.getLibrary();
      return reply.send(options.parse(library));
    } catch (error) {
      request.log.error({ err: error }, "home library error");
      return reply.code(500).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "home_library_failed",
            message: "Unable to load home library.",
          },
        }),
      );
    }
  });
}
