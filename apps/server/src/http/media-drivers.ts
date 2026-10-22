import {
  AGENT_GOVERNANCE_LIMITS,
  mediaDriverPreviewRequestSchema,
  mediaDriverPreviewResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { MediaDriverFileError } from "../features/media-drivers/preview.js";
import type { MediaDriverService } from "../features/media-drivers/service.js";
import { isZodError } from "./zod-error.js";

export async function registerMediaDriverRoutes(
  app: FastifyInstance,
  deps: {
    localAccess: LocalAccessVerifier;
    mediaDrivers: MediaDriverService;
  },
) {
  app.post(
    "/api/media-drivers/preview",
    {
      // JSON 转义最多将每字节编码为六字符；文件预算仍由运行期设置检查。
      bodyLimit: AGENT_GOVERNANCE_LIMITS.mediaDriverMaxSourceBytes.max * 6,
    },
    async (request, reply) => {
      const actor = await deps.localAccess.authenticate(request);
      if (!actor)
        return reply.code(401).send({
          error: { code: "unauthorized", message: "请重新连接本机实例" },
        });
      try {
        const input = mediaDriverPreviewRequestSchema.parse(request.body);
        const { compiledCode: _compiledCode, ...preview } =
          await deps.mediaDrivers.preview(actor, input.source);
        return reply.send(mediaDriverPreviewResponseSchema.parse(preview));
      } catch (error) {
        if (error instanceof MediaDriverFileError)
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        if (isZodError(error))
          return reply.code(400).send({
            error: {
              code: "invalid_request",
              message: "请填写完整供应商代码",
            },
          });
        throw error;
      }
    },
  );
}
