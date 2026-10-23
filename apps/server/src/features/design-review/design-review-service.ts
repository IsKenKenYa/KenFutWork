import {
  type DesignReviewAnnotation,
  type DesignReviewAnnotationCreate,
  type DesignReviewComment,
  type DesignReviewCommentCreate,
  type DesignReviewCommentUpdate,
  type DesignReviewListResponse,
  designReviewAnnotationSchema,
  designReviewCommentSchema,
  designReviewListResponseSchema,
} from "@kenfutwork/shared";
import type { LocalActor } from "../local-instance/types.js";
import type {
  DesignReviewAnnotationRow,
  DesignReviewCommentRow,
  DesignReviewRepository,
} from "./repository.js";

/**
 * 设计评审服务（Service Definition + Provider 的实现侧）。
 *
 * 行→契约一律过 zod：库里躺着的是历史形状，契约是对外承诺，两者不一致时
 * 立即失败而不是把残缺对象透给面板。
 */
export interface DesignReviewScope {
  file: string;
  projectId: string;
}

export interface DesignReviewService {
  addAnnotation(
    actor: LocalActor,
    input: DesignReviewAnnotationCreate,
  ): Promise<DesignReviewAnnotation>;
  addComment(
    actor: LocalActor,
    input: DesignReviewCommentCreate,
  ): Promise<DesignReviewComment>;
  deleteAnnotation(actor: LocalActor, id: string): Promise<boolean>;
  deleteComment(actor: LocalActor, id: string): Promise<boolean>;
  list(
    actor: LocalActor,
    scope: DesignReviewScope,
  ): Promise<DesignReviewListResponse>;
  /** 项目级列举（跨文件）：「同步到引擎」聚合 document.md 评审段用。 */
  listByProject(
    actor: LocalActor,
    projectId: string,
  ): Promise<{
    comments: DesignReviewComment[];
    annotations: DesignReviewAnnotation[];
  }>;
  updateComment(
    actor: LocalActor,
    id: string,
    patch: DesignReviewCommentUpdate,
  ): Promise<DesignReviewComment | null>;
}

function toComment(row: DesignReviewCommentRow): DesignReviewComment {
  return designReviewCommentSchema.parse({
    id: row.id,
    projectId: row.project_id,
    file: row.file_name,
    body: row.body,
    status: row.status === "resolved" ? "resolved" : "open",
    anchor: {
      path: row.anchor_path,
      rect: row.anchor_rect,
      excerpt: row.anchor_excerpt,
    },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

function toAnnotation(row: DesignReviewAnnotationRow): DesignReviewAnnotation {
  return designReviewAnnotationSchema.parse({
    id: row.id,
    projectId: row.project_id,
    file: row.file_name,
    kind:
      row.kind === "rect" || row.kind === "text" || row.kind === "mark"
        ? row.kind
        : "pen",
    text: row.text ?? null,
    color: row.color,
    strokeWidth: Number(row.stroke_width),
    points: row.points,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

export function createDesignReviewService(options: {
  repository: DesignReviewRepository;
}): DesignReviewService {
  const { repository } = options;
  return {
    async list(actor, scope) {
      const [comments, annotations] = await Promise.all([
        repository.listComments(actor.instanceId, scope.projectId, scope.file),
        repository.listAnnotations(
          actor.instanceId,
          scope.projectId,
          scope.file,
        ),
      ]);
      return designReviewListResponseSchema.parse({
        comments: comments.map(toComment),
        annotations: annotations.map(toAnnotation),
      });
    },
    async listByProject(actor, projectId) {
      const [comments, annotations] = await Promise.all([
        repository.listCommentsByProject(actor.instanceId, projectId),
        repository.listAnnotationsByProject(actor.instanceId, projectId),
      ]);
      return {
        comments: comments.map(toComment),
        annotations: annotations.map(toAnnotation),
      };
    },

    async addComment(actor, input) {
      const row = await repository.insertComment(actor.instanceId, {
        projectId: input.projectId,
        file: input.file,
        body: input.body,
        anchor: input.anchor,
      });
      if (!row) throw new Error("评论写入没有返回行。");
      return toComment(row);
    },

    async updateComment(actor, id, patch) {
      const row = await repository.updateComment(actor.instanceId, id, {
        body: patch.body,
        status: patch.status,
      });
      return row ? toComment(row) : null;
    },

    async deleteComment(actor, id) {
      return (await repository.deleteComment(actor.instanceId, id)) > 0;
    },

    async addAnnotation(actor, input) {
      const row = await repository.insertAnnotation(actor.instanceId, {
        projectId: input.projectId,
        file: input.file,
        kind: input.kind,
        color: input.color,
        strokeWidth: input.strokeWidth,
        points: input.points,
        text: input.text ?? null,
      });
      if (!row) throw new Error("标注写入没有返回行。");
      return toAnnotation(row);
    },

    async deleteAnnotation(actor, id) {
      return (await repository.deleteAnnotation(actor.instanceId, id)) > 0;
    },
  };
}
