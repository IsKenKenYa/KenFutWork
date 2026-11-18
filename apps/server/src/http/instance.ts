import {
  applicationErrorResponseSchema,
  instanceDataLocationPrepareRequestSchema,
  instanceDataLocationPrepareResponseSchema,
  instanceDataLocationResponseSchema,
  instanceDataLocationShutdownResponseSchema,
  instanceResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { LocalAccessError } from "../features/local-access/types.js";
import {
  DataLocationControlError,
  type DataLocationController,
} from "../features/local-instance/data-control.js";
import { LocalInstanceError } from "../features/local-instance/service.js";
import type { LocalInstanceService } from "../features/local-instance/types.js";

async function handle(
  request: FastifyRequest,
  reply: FastifyReply,
  action: () => Promise<unknown>,
) {
  reply.header("Cache-Control", "no-store");
  try {
    return await action();
  } catch (error) {
    if (error instanceof LocalInstanceError) {
      return reply.code(403).send(
        applicationErrorResponseSchema.parse({
          error: { code: "forbidden", message: error.message },
        }),
      );
    }
    if (
      error instanceof DataLocationControlError ||
      error instanceof LocalAccessError
    ) {
      const body = { error: { code: error.code, message: error.message } };
      if (error.code === "unauthorized")
        return reply
          .code(401)
          .send(unauthenticatedErrorResponseSchema.parse(body));
      if (
        error.code === "local_access_invalid_ticket" ||
        error.code === "local_access_unavailable"
      ) {
        return reply.code(503).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "service_unavailable",
              message: "本机接入校验暂不可用。",
            },
          }),
        );
      }
      return reply
        .code(error.statusCode)
        .send(applicationErrorResponseSchema.parse(body));
    }
    request.log.error("本机实例控制发生内部错误。");
    return reply.code(503).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: "service_unavailable",
          message: "本机实例服务暂不可用，请检查数据库与服务运行状态。",
        },
      }),
    );
  }
}

export async function registerInstanceRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    localInstance: LocalInstanceService;
    dataControl: DataLocationController;
  },
) {
  const requireActor = async (request: FastifyRequest) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor)
      throw new DataLocationControlError(
        "unauthorized",
        "本机连接凭据缺失或已失效，请从桌面重新打开浏览器入口。",
        401,
      );
    return actor;
  };

  app.get("/api/instance", (request, reply) =>
    handle(request, reply, async () =>
      reply.send(
        instanceResponseSchema.parse(
          await options.localInstance.resolve(await requireActor(request)),
        ),
      ),
    ),
  );

  app.get("/api/instance/data-location", (request, reply) =>
    handle(request, reply, async () =>
      reply.send(
        instanceDataLocationResponseSchema.parse(
          await options.dataControl.describe(await requireActor(request)),
        ),
      ),
    ),
  );

  app.post("/api/instance/data-location/prepare", (request, reply) =>
    handle(request, reply, async () => {
      const parsed = instanceDataLocationPrepareRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success)
        throw new DataLocationControlError(
          "invalid_input",
          "数据目录准备请求格式不正确。",
          400,
        );
      const abort = new AbortController();
      const disconnected = () => abort.abort();
      request.raw.socket.once("close", disconnected);
      try {
        const result = await options.dataControl.prepare(
          request,
          parsed.data,
          abort.signal,
        );
        return reply.send(
          instanceDataLocationPrepareResponseSchema.parse(result),
        );
      } finally {
        request.raw.socket.off("close", disconnected);
      }
    }),
  );

  app.post("/api/instance/data-location/shutdown", (request, reply) =>
    handle(request, reply, async () => {
      const shutdown = await options.dataControl.armShutdown(request);
      reply.raw.once("finish", () => {
        void shutdown().catch(() =>
          request.log.error("本机数据目录停机失败，维护态已解除。"),
        );
      });
      return reply
        .code(202)
        .send(
          instanceDataLocationShutdownResponseSchema.parse({ accepted: true }),
        );
    }),
  );
}
