import {
  applicationErrorResponseSchema,
  chatMessageCreateRequestSchema,
  messageCreateResponseSchema,
  messageListResponseSchema,
  sessionCreateResponseSchema,
  sessionListResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type ChatService,
  ChatServiceError,
} from "../features/chat/chat-service.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { LocalInstanceError } from "../features/local-instance/service.js";
import { isZodError } from "./zod-error.js";

export async function registerChatRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    chatService: ChatService;
  },
) {
  // List sessions for a canvas
  app.get<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId/sessions",
    async (request, reply) => {
      try {
        const user = await options.localAccess.authenticate(request);
        if (!user) return sendUnauthorized(reply);

        const sessions = await options.chatService.listSessions(
          user,
          request.params.canvasId,
        );

        return reply
          .code(200)
          .send(sessionListResponseSchema.parse({ sessions }));
      } catch (error) {
        return sendChatError(error, reply);
      }
    },
  );

  // Create a new session
  app.post<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId/sessions",
    async (request, reply) => {
      try {
        const user = await options.localAccess.authenticate(request);
        if (!user) return sendUnauthorized(reply);

        const body = request.body as { title?: string } | undefined;
        const session = await options.chatService.createSession(
          user,
          request.params.canvasId,
          body?.title,
        );

        return reply
          .code(201)
          .send(sessionCreateResponseSchema.parse({ session }));
      } catch (error) {
        return sendChatError(error, reply);
      }
    },
  );

  // Update session title
  app.patch<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      try {
        const user = await options.localAccess.authenticate(request);
        if (!user) return sendUnauthorized(reply);

        const body = request.body as { title?: string } | undefined;
        if (body?.title) {
          await options.chatService.updateSessionTitle(
            user,
            request.params.sessionId,
            body.title,
          );
        }

        return reply.code(200).send({ ok: true });
      } catch (error) {
        return sendChatError(error, reply);
      }
    },
  );

  // Delete a session
  app.delete<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      try {
        const user = await options.localAccess.authenticate(request);
        if (!user) return sendUnauthorized(reply);

        await options.chatService.deleteSession(user, request.params.sessionId);

        return reply.code(200).send({ ok: true });
      } catch (error) {
        return sendChatError(error, reply);
      }
    },
  );

  // List messages for a session
  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/messages",
    async (request, reply) => {
      try {
        const user = await options.localAccess.authenticate(request);
        if (!user) return sendUnauthorized(reply);

        const messages = await options.chatService.listMessages(
          user,
          request.params.sessionId,
        );

        request.log.info(
          { sessionId: request.params.sessionId, count: messages.length },
          "chat.listMessages OK",
        );
        return reply
          .code(200)
          .send(messageListResponseSchema.parse({ messages }));
      } catch (error) {
        request.log.error(
          { sessionId: request.params.sessionId, err: error },
          "chat.listMessages FAILED",
        );
        return sendChatError(error, reply);
      }
    },
  );

  // Create a message
  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/messages",
    { bodyLimit: 10 * 1024 * 1024 }, // 10 MB — messages may include base64 image data from canvas selections
    async (request, reply) => {
      try {
        const user = await options.localAccess.authenticate(request);
        if (!user) return sendUnauthorized(reply);

        const input = chatMessageCreateRequestSchema.parse(request.body);
        const message = await options.chatService.createMessage(
          user,
          request.params.sessionId,
          input,
        );

        request.log.info(
          {
            sessionId: request.params.sessionId,
            role: input.role,
            messageId: message.id,
          },
          "chat.createMessage OK",
        );
        return reply
          .code(201)
          .send(messageCreateResponseSchema.parse({ message }));
      } catch (error) {
        request.log.error(
          { sessionId: request.params.sessionId, err: error },
          "chat.createMessage FAILED",
        );
        return sendChatError(error, reply);
      }
    },
  );
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "缺少或无效的本机接入凭据。",
      },
    }),
  );
}

function sendChatError(error: unknown, reply: FastifyReply) {
  if (
    error instanceof ChatServiceError ||
    error instanceof LocalInstanceError
  ) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: error.code,
          message: error.message,
        },
      }),
    );
  }

  if (isZodError(error)) {
    return reply.code(400).send({
      issues: error.issues,
      message: "Invalid request body",
    });
  }

  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "application_error",
        message: "Internal server error.",
      },
    }),
  );
}
