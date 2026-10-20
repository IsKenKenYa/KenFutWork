import {
  applicationErrorResponseSchema,
  designReviewAnnotationCreateSchema,
  designReviewAnnotationResponseSchema,
  designReviewCommentCreateSchema,
  designReviewCommentResponseSchema,
  designReviewCommentUpdateSchema,
  designReviewDeleteResponseSchema,
  designReviewListResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { LocalActor } from "../features/local-instance/types.js";
import type { DesignReviewService } from "../features/design-review/design-review-service.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";

/**
 * 设计评审路由（本机接入验证）。
 *
 * 面板的评论侧栏、标注层与画布上的图钉都吃这几条；作用域是
 * `projectId + file`（一块画布的一个设计文件），实例归属由服务侧按
 * `actor.instanceId` 收口，路由不吃任何 `instanceId` 参数。
 */
export async function registerDesignReviewRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    designReviewService: DesignReviewService;
  },
): Promise<void> {
  const actor = (
    request: FastifyRequest,
  ): Promise<LocalActor | null> => options.localAccess.authenticate(request);

  const unauthorized = (reply: FastifyReply) =>
    reply.code(401).send(
      unauthenticatedErrorResponseSchema.parse({
        error: {
          code: "unauthorized",
          message: "本机接入凭据缺失或无效。",
        },
      }),
    );

  const badRequest = (reply: FastifyReply, message: string) =>
    reply
      .code(400)
      .send(
        applicationErrorResponseSchema.parse({
          error: { code: "application_error", message },
        }),
      );

  const notFound = (reply: FastifyReply, message: string) =>
    reply
      .code(404)
      .send(
        applicationErrorResponseSchema.parse({
          error: { code: "application_error", message },
        }),
      );

  app.get("/api/design-review", async (request, reply) => {
    const local = await actor(request);
    if (!local) return unauthorized(reply);
    const query = request.query as { projectId?: string; file?: string };
    const projectId = query.projectId?.trim();
    const file = query.file?.trim();
    if (!projectId || !file)
      return badRequest(reply, "缺少画布 id 或文件名。");
    return reply.send(
      designReviewListResponseSchema.parse(
        await options.designReviewService.list(local, { projectId, file }),
      ),
    );
  });

  app.post("/api/design-review/comments", async (request, reply) => {
    const local = await actor(request);
    if (!local) return unauthorized(reply);
    const parsed = designReviewCommentCreateSchema.safeParse(
      request.body ?? {},
    );
    if (!parsed.success) return badRequest(reply, "评论格式不正确。");
    return reply.send(
      designReviewCommentResponseSchema.parse({
        comment: await options.designReviewService.addComment(
          local,
          parsed.data,
        ),
      }),
    );
  });

  app.patch("/api/design-review/comments/:id", async (request, reply) => {
    const local = await actor(request);
    if (!local) return unauthorized(reply);
    const parsed = designReviewCommentUpdateSchema.safeParse(
      request.body ?? {},
    );
    if (!parsed.success) return badRequest(reply, "评论改动格式不正确。");
    const id = (request.params as { id?: string }).id?.trim();
    if (!id) return badRequest(reply, "缺少评论 id。");
    const comment = await options.designReviewService.updateComment(
      local,
      id,
      parsed.data,
    );
    if (!comment) return notFound(reply, "这条评论已经不在了。");
    return reply.send(designReviewCommentResponseSchema.parse({ comment }));
  });

  app.delete("/api/design-review/comments/:id", async (request, reply) => {
    const local = await actor(request);
    if (!local) return unauthorized(reply);
    const id = (request.params as { id?: string }).id?.trim();
    if (!id) return badRequest(reply, "缺少评论 id。");
    if (!(await options.designReviewService.deleteComment(local, id)))
      return notFound(reply, "这条评论已经不在了。");
    return reply.send(designReviewDeleteResponseSchema.parse({ ok: true }));
  });

  app.post("/api/design-review/annotations", async (request, reply) => {
    const local = await actor(request);
    if (!local) return unauthorized(reply);
    const parsed = designReviewAnnotationCreateSchema.safeParse(
      request.body ?? {},
    );
    if (!parsed.success) return badRequest(reply, "标注格式不正确。");
    return reply.send(
      designReviewAnnotationResponseSchema.parse({
        annotation: await options.designReviewService.addAnnotation(
          local,
          parsed.data,
        ),
      }),
    );
  });

  app.delete("/api/design-review/annotations/:id", async (request, reply) => {
    const local = await actor(request);
    if (!local) return unauthorized(reply);
    const id = (request.params as { id?: string }).id?.trim();
    if (!id) return badRequest(reply, "缺少标注 id。");
    if (!(await options.designReviewService.deleteAnnotation(local, id)))
      return notFound(reply, "这条标注已经不在了。");
    return reply.send(designReviewDeleteResponseSchema.parse({ ok: true }));
  });
}
