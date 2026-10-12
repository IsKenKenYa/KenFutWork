import {
  applicationErrorResponseSchema,
  projectDirectoryRelinkParamsSchema,
  projectDirectoryRelinkRequestSchema,
  projectDirectoryRelinkResponseSchema,
  projectDirectoryRelinkSnapshotSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import {
  ProjectDirectoryRelinkError,
  type ProjectDirectoryRelinkService,
} from "../features/projects/directory-relink.js";
import { isZodError } from "./zod-error.js";
export async function registerProjectDirectoryRelinkRoutes(
  app: FastifyInstance,
  deps: {
    localAccess: LocalAccessVerifier;
    relink: ProjectDirectoryRelinkService;
  },
) {
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    read: boolean,
  ) {
    try {
      const actor = await deps.localAccess.authenticate(request);
      if (!actor)
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "缺少或无效的本机接入凭据。",
            },
          }),
        );
      const { projectId } = projectDirectoryRelinkParamsSchema.parse(
        request.params,
      );
      if (read)
        return reply.send(
          projectDirectoryRelinkSnapshotSchema.parse(
            await deps.relink.snapshot(actor, projectId),
          ),
        );
      const input = projectDirectoryRelinkRequestSchema.parse(request.body);
      return reply.send(
        projectDirectoryRelinkResponseSchema.parse(
          await deps.relink.relink(actor, projectId, input),
        ),
      );
    } catch (error) {
      if (isZodError(error) || error instanceof ProjectDirectoryRelinkError)
        return reply
          .code(
            error instanceof ProjectDirectoryRelinkError
              ? error.statusCode
              : 400,
          )
          .send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "invalid_request",
                message:
                  error instanceof ProjectDirectoryRelinkError
                    ? error.message
                    : "目录关联参数无效，请刷新后重试。",
              },
            }),
          );
      throw error;
    }
  }
  app.get("/api/projects/:projectId/relink-directory", (request, reply) =>
    handle(request, reply, true),
  );
  app.post("/api/projects/:projectId/relink-directory", (request, reply) =>
    handle(request, reply, false),
  );
}
