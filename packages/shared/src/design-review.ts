import { z } from "zod";

/**
 * 设计评审（画布上的评论与标注）——本仓自持的数据面。
 *
 * 为什么不用上游 daemon 的 comments API：它绑 conversation，且带 workspace/团队
 * 成员鉴权（作者-only 编辑、云端 relay 同步、按 team 可见性切换归属），与本地优先
 * 免账户（`DEC-20`）不是一个形态。上游那套继续服务它自己的应用内运行时；本仓面板
 * 的评论与标注一律存这里，一块画布（projectId）+ 一个文件（file）为作用域。
 *
 * 锚点的身份证是 **CSS 路径**（`#id` 或 `body > div:nth-of-type(2) > p`）：
 * 设计文件被引擎重新生成后路径可能失效，届时按 `rect` 兜底显示并如实标注偏移，
 * 不静默把评论挪到别的元素上。
 */

/** 文档坐标矩形（未缩放、未滚动的 CSS 像素）。 */
export const designReviewRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite(),
  h: z.number().finite(),
});
export type DesignReviewRect = z.infer<typeof designReviewRectSchema>;

/** 评论锚点：路径为主，矩形与摘录为兜底。 */
export const designReviewAnchorSchema = z.object({
  path: z.string().min(1).max(600),
  rect: designReviewRectSchema,
  /** 锚点附近的元素文字摘录，用于路径失效时人眼判断「这条说的是哪块」。 */
  excerpt: z.string().max(200),
});
export type DesignReviewAnchor = z.infer<typeof designReviewAnchorSchema>;

export const designReviewCommentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  file: z.string().min(1),
  body: z.string().min(1).max(4000),
  status: z.enum(["open", "resolved"]),
  anchor: designReviewAnchorSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type DesignReviewComment = z.infer<typeof designReviewCommentSchema>;

/**
 * 标注笔迹：点集按**文档尺寸归一化**（0..1）存储。
 *
 * 存归一化坐标而不是像素，是因为同一块画布会在桌面端/平板/手机三种视口与
 * 50%..200% 缩放之间切换——像素坐标每换一次视口就整体错位。
 */
export const designReviewAnnotationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  file: z.string().min(1),
  kind: z.enum(["pen", "rect", "text", "mark"]),
  text: z.string().max(500).nullable().optional(),
  color: z.string().min(1).max(32),
  strokeWidth: z.number().finite().positive().max(64),
  points: z
    .array(z.tuple([z.number().finite(), z.number().finite()]))
    .min(2)
    .max(4000),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type DesignReviewAnnotation = z.infer<
  typeof designReviewAnnotationSchema
>;

/** 一次读全：面板进画布就要这两份清单。 */
export const designReviewListResponseSchema = z.object({
  comments: z.array(designReviewCommentSchema).max(500),
  annotations: z.array(designReviewAnnotationSchema).max(500),
});
export type DesignReviewListResponse = z.infer<
  typeof designReviewListResponseSchema
>;

const scopeSchema = z.object({
  projectId: z.string().min(1),
  file: z.string().min(1),
});

export const designReviewCommentCreateSchema = scopeSchema.extend({
  body: z.string().trim().min(1).max(4000),
  anchor: designReviewAnchorSchema,
});
export type DesignReviewCommentCreate = z.infer<
  typeof designReviewCommentCreateSchema
>;

/** 编辑只放开正文与状态；锚点一旦落定不再改（改它等于换了一条讨论的对象）。 */
export const designReviewCommentUpdateSchema = z.object({
  body: z.string().trim().min(1).max(4000).optional(),
  status: z.enum(["open", "resolved"]).optional(),
});
export type DesignReviewCommentUpdate = z.infer<
  typeof designReviewCommentUpdateSchema
>;

export const designReviewAnnotationCreateSchema = scopeSchema.extend({
  kind: z.enum(["pen", "rect", "text", "mark"]),
  text: z.string().max(500).nullable().optional(),
  color: z.string().trim().min(1).max(32),
  strokeWidth: z.number().finite().positive().max(64),
  points: z
    .array(z.tuple([z.number().finite(), z.number().finite()]))
    .min(2)
    .max(4000),
});
export type DesignReviewAnnotationCreate = z.infer<
  typeof designReviewAnnotationCreateSchema
>;

export const designReviewCommentResponseSchema = z.object({
  comment: designReviewCommentSchema,
});

export const designReviewAnnotationResponseSchema = z.object({
  annotation: designReviewAnnotationSchema,
});

export const designReviewDeleteResponseSchema = z.object({
  ok: z.literal(true),
});
