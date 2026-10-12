import {
  applicationErrorResponseSchema,
  designGoalBudgetRequestSchema,
  designGoalCreateRequestSchema,
  designGoalPauseRequestSchema,
  designGoalResponseSchema,
  designGoalResumeRequestSchema,
  designTaskParamsSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DesignGoalsService } from "../features/execution/design-goals-types.js";
import type { DesignRunHost } from "../features/execution/design-run-host-types.js";
import { DesignTaskError } from "../features/execution/design-task-errors.js";
import type { DesignTasksService } from "../features/execution/design-task-types.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { isZodError } from "./zod-error.js";

export async function registerDesignGoalRoutes(
  app: FastifyInstance,
  deps: {
    localAccess: LocalAccessVerifier;
    designGoals: Pick<
      DesignGoalsService,
      "readTask" | "create" | "pause" | "resume" | "setBudget"
    >;
    designTasks: Pick<DesignTasksService, "readPolicy">;
    designRunHost: Pick<DesignRunHost, "dispatchGoal" | "stop">;
  },
) {
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    action: "read" | "create" | "pause" | "resume" | "budget",
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
      const { taskId } = designTaskParamsSchema.parse(request.params);
      // Always authorize the actual persistent Task, including when it has no Goal.
      await deps.designTasks.readPolicy(actor, taskId);
      if (action === "create") {
        const input = designGoalCreateRequestSchema.parse(request.body);
        await deps.designGoals.create(actor, {
          taskId,
          objective: input.objective,
          ...(input.model ? { model: input.model } : {}),
          expectedBranchGeneration: input.expectedBranchGeneration,
          expectedGoal: input.expectedGoal,
          ...(input.tokenBudget !== undefined
            ? { tokenBudget: input.tokenBudget }
            : {}),
        });
        await deps.designRunHost.dispatchGoal(actor.instanceId, taskId);
      } else if (action === "resume") {
        const { model, ...resume } = designGoalResumeRequestSchema.parse(
          request.body,
        );
        await deps.designGoals.resume(actor, {
          taskId,
          ...resume,
          ...(model ? { model } : {}),
        });
        await deps.designRunHost.dispatchGoal(actor.instanceId, taskId);
      } else if (action === "pause" || action === "budget") {
        const goal =
          action === "pause"
            ? await deps.designGoals.pause(actor, {
                taskId,
                ...designGoalPauseRequestSchema.parse(request.body),
              })
            : await deps.designGoals.setBudget(actor, {
                taskId,
                ...designGoalBudgetRequestSchema.parse(request.body),
              });
        if (goal.status === "paused" && goal.claimedRunId)
          await deps.designRunHost.stop(actor, {
            taskId,
            expectedRunId: goal.claimedRunId,
          });
      }
      const goal = await deps.designGoals.readTask(actor, taskId);
      const task = await deps.designTasks.readPolicy(actor, taskId);
      return reply.code(200).send(
        designGoalResponseSchema.parse({
          goal,
          task,
          acceptedRunId:
            goal?.claimedRunId && goal.claimedRunId === task.activeRunId
              ? goal.claimedRunId
              : null,
        }),
      );
    } catch (error) {
      if (isZodError(error))
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "invalid_request",
              message: "目标参数无效，请刷新后重试。",
            },
          }),
        );
      if (error instanceof DesignTaskError)
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_request", message: error.message },
          }),
        );
      throw error;
    }
  }
  app.get("/api/design-tasks/:taskId/goal", (request, reply) =>
    handle(request, reply, "read"),
  );
  app.post("/api/design-tasks/:taskId/goal", (request, reply) =>
    handle(request, reply, "create"),
  );
  app.post("/api/design-tasks/:taskId/goal/pause", (request, reply) =>
    handle(request, reply, "pause"),
  );
  app.post("/api/design-tasks/:taskId/goal/resume", (request, reply) =>
    handle(request, reply, "resume"),
  );
  app.patch("/api/design-tasks/:taskId/goal/budget", (request, reply) =>
    handle(request, reply, "budget"),
  );
}
