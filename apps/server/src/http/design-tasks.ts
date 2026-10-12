import {
  applicationErrorResponseSchema,
  designTaskParamsSchema,
  designTaskPolicyResponseSchema,
  designTaskPolicyUpdateRequestSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { DesignTaskError } from "../features/execution/design-task-errors.js";
import type { DesignTasksService } from "../features/execution/design-task-types.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { isZodError } from "./zod-error.js";

export async function registerDesignTaskRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    designTasks: Pick<
      DesignTasksService,
      "provision" | "readPolicy" | "updatePolicy"
    >;
  },
) {
  const taskRoute = async (
    request: Parameters<LocalAccessVerifier["authenticate"]>[0] & {
      params: unknown;
      body?: unknown;
    },
    reply: FastifyReply,
    action: "provision" | "read" | "update",
  ) => {
    try {
      const actor = await options.localAccess.authenticate(request);
      if (!actor)
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "缺少或无效的本机接入凭据。",
            },
          }),
        );
      const { taskId } = designTaskParamsSchema.parse(request.params);
      const policy =
        action === "provision"
          ? undefined
          : await options.designTasks.readPolicy(actor, taskId);
      let task =
        action === "provision"
          ? await options.designTasks.provision(actor, taskId)
          : policy;
      if (action === "update" && policy) {
        const input = designTaskPolicyUpdateRequestSchema.parse(request.body);
        if (
          input.expectedScopeGeneration !== policy.scopeGeneration ||
          input.expectedBranchGeneration !== policy.branchGeneration
        )
          throw new DesignTaskError(
            "design_task_policy_changed",
            "任务权限已变更，请刷新。",
          );
        task = await options.designTasks.updatePolicy(actor, {
          taskId,
          scopeGeneration: input.expectedScopeGeneration,
          planningEpoch: policy.planningEpoch,
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
          ...(input.planEnabled !== undefined
            ? { planEnabled: input.planEnabled }
            : {}),
        });
      }
      return reply
        .code(200)
        .send(designTaskPolicyResponseSchema.parse({ task }));
    } catch (error) {
      if (isZodError(error))
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "invalid_request",
              message:
                action === "update"
                  ? "任务或权限参数无效，请刷新。"
                  : "Task ID 必须是有效的 UUID。",
            },
          }),
        );
      if (error instanceof DesignTaskError) {
        const notFound =
          error.code === "design_task_unavailable" ||
          error.code === "design_task_unprovisioned";
        return reply.code(notFound ? 404 : error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: notFound
                ? "session_not_found"
                : error.code === "design_task_host_busy"
                  ? "run_in_progress"
                  : "invalid_request",
              message: error.message,
            },
          }),
        );
      }
      throw error;
    }
  };
  app.post<{ Params: { taskId: string } }>(
    "/api/design-tasks/:taskId/provision",
    (request, reply) => taskRoute(request, reply, "provision"),
  );
  app.patch<{ Params: { taskId: string } }>(
    "/api/design-tasks/:taskId",
    (request, reply) => taskRoute(request, reply, "update"),
  );
  app.get<{ Params: { taskId: string } }>(
    "/api/design-tasks/:taskId",
    (request, reply) => taskRoute(request, reply, "read"),
  );
}
