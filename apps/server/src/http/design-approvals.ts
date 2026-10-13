import {
  applicationErrorResponseSchema,
  designApprovalListResponseSchema,
  designApprovalParamsSchema,
  designApprovalResolveRequestSchema,
  designApprovalResolveResponseSchema,
  designTaskParamsSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance } from "fastify";
import {
  DesignApprovalError,
  type DesignApprovalsService,
} from "../features/execution/design-approvals.js";
import { DesignTaskError } from "../features/execution/design-task-errors.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { isZodError } from "./zod-error.js";

export function registerDesignApprovalRoutes(
  app: FastifyInstance,
  options: {
    localAccess: Pick<LocalAccessVerifier, "authenticate">;
    approvals: DesignApprovalsService;
  },
) {
  const route = async (
    request: Parameters<LocalAccessVerifier["authenticate"]>[0] & {
      params: unknown;
      body: unknown;
    },
    reply: import("fastify").FastifyReply,
    resolve: boolean,
  ) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor)
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: { code: "unauthorized", message: "请先建立本机连接。" },
        }),
      );
    try {
      if (!resolve) {
        const { taskId } = designTaskParamsSchema.parse(request.params);
        return reply.send(
          designApprovalListResponseSchema.parse({
            approvals: await options.approvals.list(actor, taskId),
          }),
        );
      }
      const { taskId, interactionId } = designApprovalParamsSchema.parse(
        request.params,
      );
      const { answer } = designApprovalResolveRequestSchema.parse(request.body);
      return reply.send(
        designApprovalResolveResponseSchema.parse(
          await options.approvals.resolve(actor, taskId, interactionId, answer),
        ),
      );
    } catch (error) {
      if (isZodError(error))
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "invalid_request",
              message: "审批参数无效，请检查任务和答案。",
            },
          }),
        );
      if (
        error instanceof DesignApprovalError ||
        error instanceof DesignTaskError
      ) {
        const status =
          error instanceof DesignTaskError &&
          ["design_task_unavailable", "design_task_unprovisioned"].includes(
            error.code,
          )
            ? 404
            : error.statusCode;
        return reply.code(status).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: status === 404 ? "session_not_found" : "invalid_request",
              message: error.message,
            },
          }),
        );
      }
      throw error;
    }
  };
  app.get("/api/design-tasks/:taskId/approvals", (request, reply) =>
    route(request, reply, false),
  );
  app.post(
    "/api/design-tasks/:taskId/approvals/:interactionId/resolve",
    (request, reply) => route(request, reply, true),
  );
}
