import {
  localAccessClientCreateRequestSchema,
  localAccessClientCreateResponseSchema,
  localAccessClientListResponseSchema,
  localAccessClientParamsSchema,
  localAccessConnectRequestSchema,
  localAccessConnectResponseSchema,
  localAccessErrorResponseSchema,
  localAccessTicketRequestSchema,
  localAccessTicketResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { LocalAccessError, type LocalAccessService } from "./types.js";

function sendError(reply: FastifyReply, error: LocalAccessError) {
  return reply.code(error.statusCode).send(
    localAccessErrorResponseSchema.parse({
      error: { code: error.code, message: error.message },
    }),
  );
}

async function handle(
  request: FastifyRequest,
  reply: FastifyReply,
  action: () => Promise<unknown>,
) {
  reply.header("Cache-Control", "no-store");
  try {
    return await action();
  } catch (error) {
    if (error instanceof LocalAccessError) return sendError(reply, error);
    // 未知异常可能携带凭据上下文；日志与响应都不转储对象或输入。
    request.log.error("本机访问服务发生内部错误。");
    return sendError(
      reply,
      new LocalAccessError(
        "local_access_unavailable",
        "本机访问服务暂不可用，请检查服务和数据库运行状态。",
        503,
      ),
    );
  }
}

function invalidInput(): LocalAccessError {
  return new LocalAccessError("invalid_input", "本机连接请求格式不正确。", 400);
}

export async function registerLocalAccessRoutes(
  app: FastifyInstance,
  options: { localAccessService: LocalAccessService },
): Promise<void> {
  const service = options.localAccessService;

  app.post("/api/local-access/tickets", (request, reply) =>
    handle(request, reply, async () => {
      const parsed = localAccessTicketRequestSchema.safeParse(
        request.body ?? {},
      );
      if (!parsed.success) throw invalidInput();
      return reply
        .code(201)
        .send(
          localAccessTicketResponseSchema.parse(
            await service.issueTicket(request),
          ),
        );
    }),
  );

  app.post("/api/local-access/connect", (request, reply) =>
    handle(request, reply, async () => {
      const parsed = localAccessConnectRequestSchema.safeParse(request.body);
      if (!parsed.success) throw invalidInput();
      const connected = await service.consumeTicket(request, parsed.data);
      reply.header("Set-Cookie", connected.cookie);
      return reply.send(
        localAccessConnectResponseSchema.parse({
          instanceId: connected.actor.instanceId,
          client: connected.client,
        }),
      );
    }),
  );

  app.get("/api/local-access/clients", (request, reply) =>
    handle(request, reply, async () =>
      reply.send(
        localAccessClientListResponseSchema.parse({
          clients: await service.listClients(request),
        }),
      ),
    ),
  );

  app.post("/api/local-access/clients", (request, reply) =>
    handle(request, reply, async () => {
      const parsed = localAccessClientCreateRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) throw invalidInput();
      return reply
        .code(201)
        .send(
          localAccessClientCreateResponseSchema.parse(
            await service.createApiClient(request, parsed.data),
          ),
        );
    }),
  );

  app.delete("/api/local-access/clients/:id", (request, reply) =>
    handle(request, reply, async () => {
      const parsed = localAccessClientParamsSchema.safeParse(request.params);
      if (!parsed.success) throw invalidInput();
      await service.revokeClient(request, parsed.data.id);
      return reply.code(204).send();
    }),
  );
}
