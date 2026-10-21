import { randomUUID } from "node:crypto";
import type { PersistenceService } from "../persistence/types.js";

/**
 * 设计评审的数据访问。
 *
 * **隔离口径**：两张表都以 `instance_id` 打头（`FORM-9`，DB 层无 RLS 兜底），
 * 每条语句都显式写 `:instance` 谓词——归属校验与读写是同一条语句，
 * 不存在「先查归属再操作」的窗口。
 *
 * 画布 id 是上游 project 的 uuid，但**不建外键**：本仓不拥有那块画布的生命周期
 * （上游删了 project，这里的评论就成了孤儿，按 `project_id` 一并清掉即可，
 * 不需要跨进程的引用完整性）。
 */

/** `type` 而非 `interface`：行类型要满足 `SqlRow`（需要隐式索引签名）。 */
export type DesignReviewCommentRow = {
  anchor_excerpt: string;
  anchor_path: string;
  anchor_rect: unknown;
  body: string;
  created_at: number;
  file_name: string;
  id: string;
  project_id: string;
  status: string;
  updated_at: number;
};

export type DesignReviewAnnotationRow = {
  color: string;
  created_at: number;
  file_name: string;
  id: string;
  kind: string;
  points: unknown;
  project_id: string;
  stroke_width: string | number;
  updated_at: number;
};

const COMMENT_COLUMNS = `id, project_id, file_name, body, status,
  anchor_path, anchor_excerpt, anchor_rect,
  floor(extract(epoch from created_at) * 1000) as created_at,
  floor(extract(epoch from updated_at) * 1000) as updated_at`;

const ANNOTATION_COLUMNS = `id, project_id, file_name, kind, color, stroke_width, points,
  floor(extract(epoch from created_at) * 1000) as created_at,
  floor(extract(epoch from updated_at) * 1000) as updated_at`;

export interface NewDesignReviewComment {
  anchor: { excerpt: string; path: string; rect: unknown };
  body: string;
  file: string;
  projectId: string;
}

export interface NewDesignReviewAnnotation {
  color: string;
  file: string;
  kind: string;
  points: unknown;
  projectId: string;
  strokeWidth: number;
}

export interface DesignReviewRepository {
  deleteAnnotation(instanceId: string, id: string): Promise<number>;
  deleteComment(instanceId: string, id: string): Promise<number>;
  insertAnnotation(
    instanceId: string,
    input: NewDesignReviewAnnotation,
  ): Promise<DesignReviewAnnotationRow | null>;
  insertComment(
    instanceId: string,
    input: NewDesignReviewComment,
  ): Promise<DesignReviewCommentRow | null>;
  listAnnotations(
    instanceId: string,
    projectId: string,
    file: string,
  ): Promise<DesignReviewAnnotationRow[]>;
  listComments(
    instanceId: string,
    projectId: string,
    file: string,
  ): Promise<DesignReviewCommentRow[]>;
  listAnnotationsByProject(
    instanceId: string,
    projectId: string,
  ): Promise<DesignReviewAnnotationRow[]>;
  listCommentsByProject(
    instanceId: string,
    projectId: string,
  ): Promise<DesignReviewCommentRow[]>;
  updateComment(
    instanceId: string,
    id: string,
    patch: {
      body?: string | undefined;
      status?: string | undefined;
    },
  ): Promise<DesignReviewCommentRow | null>;
}

export function createDesignReviewRepository(
  persistence: PersistenceService,
): DesignReviewRepository {
  return {
    async listComments(instanceId, projectId, file) {
      return persistence.forInstance(instanceId).query<DesignReviewCommentRow>(
        `select ${COMMENT_COLUMNS}
           from public.design_review_comments
          where instance_id = :instance
            and project_id = $1
            and file_name = $2
          order by created_at asc`,
        [projectId, file],
      );
    },

    async listCommentsByProject(instanceId, projectId) {
      return persistence.forInstance(instanceId).query<DesignReviewCommentRow>(
        `select ${COMMENT_COLUMNS}
           from public.design_review_comments
          where instance_id = :instance
            and project_id = $1
          order by file_name asc, created_at asc`,
        [projectId],
      );
    },

    async listAnnotationsByProject(instanceId, projectId) {
      return persistence
        .forInstance(instanceId)
        .query<DesignReviewAnnotationRow>(
          `select ${ANNOTATION_COLUMNS}
           from public.design_review_annotations
          where instance_id = :instance
            and project_id = $1
          order by file_name asc, created_at asc`,
          [projectId],
        );
    },

    async insertComment(instanceId, input) {
      const id = randomUUID();
      return persistence
        .forInstance(instanceId)
        .queryOne<DesignReviewCommentRow>(
          `insert into public.design_review_comments
           (instance_id, id, project_id, file_name, body,
            anchor_path, anchor_rect, anchor_excerpt)
         values (:instance, $1, $2, $3, $4, $5, $6::jsonb, $7)
         returning ${COMMENT_COLUMNS}`,
          [
            id,
            input.projectId,
            input.file,
            input.body,
            input.anchor.path,
            JSON.stringify(input.anchor.rect),
            input.anchor.excerpt,
          ],
        );
    },

    async updateComment(instanceId, id, patch) {
      // 单语句条件更新：既写回新值，也把「没有这条/不属于本实例」压成 null。
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<DesignReviewCommentRow>(
          `update public.design_review_comments
              set body = coalesce($1, body),
                  status = coalesce($2, status),
                  updated_at = now()
            where instance_id = :instance
              and id = $3
            returning ${COMMENT_COLUMNS}`,
          [patch.body ?? null, patch.status ?? null, id],
        );
      return row ?? null;
    },

    async deleteComment(instanceId, id) {
      return persistence.forInstance(instanceId).execute(
        `delete from public.design_review_comments
          where instance_id = :instance
            and id = $1`,
        [id],
      );
    },

    async listAnnotations(instanceId, projectId, file) {
      return persistence
        .forInstance(instanceId)
        .query<DesignReviewAnnotationRow>(
          `select ${ANNOTATION_COLUMNS}
             from public.design_review_annotations
            where instance_id = :instance
              and project_id = $1
              and file_name = $2
            order by created_at asc`,
          [projectId, file],
        );
    },

    async insertAnnotation(instanceId, input) {
      const id = randomUUID();
      return persistence
        .forInstance(instanceId)
        .queryOne<DesignReviewAnnotationRow>(
          `insert into public.design_review_annotations
             (instance_id, id, project_id, file_name, kind, color,
              stroke_width, points)
           values (:instance, $1, $2, $3, $4, $5, $6, $7::jsonb)
           returning ${ANNOTATION_COLUMNS}`,
          [
            id,
            input.projectId,
            input.file,
            input.kind,
            input.color,
            input.strokeWidth,
            JSON.stringify(input.points),
          ],
        );
    },

    async deleteAnnotation(instanceId, id) {
      return persistence.forInstance(instanceId).execute(
        `delete from public.design_review_annotations
          where instance_id = :instance
            and id = $1`,
        [id],
      );
    },
  };
}
