import { z } from "zod";

/**
 * Code 模式检查点（影子 git）的跨端契约。
 *
 * 检查点是 agent 每轮在沙箱工作目录上的影子快照（影子仓库在服务端数据目录，
 * 绝不碰用户自己的 .git）；客户端据此展示「每轮改了什么」并一键回滚。
 * 影子提交行数统计沿用 numstat 口径：二进制文件没有行数概念，added/deleted 为
 * null（不伪造 0）。
 */

/** 影子提交 sha：git rev-parse 的 40 位小写十六进制。 */
const shadowCommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "影子提交 sha 必须是 40 位十六进制");

/** 检查点种类：turn=轮次快照（开始/结束）、restore=回滚恢复点、baseline 预留。 */
export const checkpointKindSchema = z.enum(["baseline", "turn", "restore"]);

export const checkpointSummarySchema = z.object({
  id: z.string().min(1),
  /** 产生该检查点的 run；回滚恢复点没有 run，为 null。 */
  runId: z.string().nullable(),
  kind: checkpointKindSchema,
  label: z.string().min(1),
  shadowCommit: shadowCommitSchema,
  filesChanged: z.number().int().min(0),
  insertions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  createdAt: z.string().min(1),
});

export const checkpointListQuerySchema = z.object({
  canvasId: z.string().min(1),
});

export const checkpointListResponseSchema = z.object({
  checkpoints: z.array(checkpointSummarySchema),
});

/** 单文件增删行数（numstat 口径；二进制文件两行数为 null）。 */
export const checkpointFileChangeSchema = z.object({
  path: z.string().min(1),
  added: z.number().int().min(0).nullable(),
  deleted: z.number().int().min(0).nullable(),
});

/** 某检查点相对上一检查点的统一 diff 与逐文件增删。 */
export const checkpointDiffResponseSchema = z.object({
  diff: z.string(),
  files: z.array(checkpointFileChangeSchema),
});

/** 恢复预览：工作区相对目标检查点的未提交差异（含增删汇总）。 */
export const checkpointPreviewResponseSchema = z.object({
  /** 恢复目标的影子提交 sha。 */
  targetSha: shadowCommitSchema,
  files: z.array(checkpointFileChangeSchema),
  filesChanged: z.number().int().min(0),
  insertions: z.number().int().min(0),
  deletions: z.number().int().min(0),
});

/** 回滚结果：恢复后的当前状态（无差异时即目标检查点本身）。 */
export const checkpointRestoreResponseSchema = z.object({
  checkpoint: checkpointSummarySchema,
});

/** 某检查点相对上一检查点的逐文件变更清单（每轮文件撤销的列表面）。 */
export const checkpointFilesResponseSchema = z.object({
  files: z.array(checkpointFileChangeSchema),
});

/** 每文件撤销：把单个文件恢复到该检查点的状态（检查点之后新建的文件则删除）。 */
export const checkpointRestoreFileRequestSchema = z.object({
  /** 相对工作目录根的路径（不允许绝对路径与 `..` 段）。 */
  path: z.string().min(1),
});

// 供前端/API 封装直接引用的推断类型（schema 单源，类型跟随，与 admin-contracts 同一口径）。
export type CheckpointKind = z.infer<typeof checkpointKindSchema>;
export type CheckpointSummary = z.infer<typeof checkpointSummarySchema>;
export type CheckpointFileChange = z.infer<typeof checkpointFileChangeSchema>;
