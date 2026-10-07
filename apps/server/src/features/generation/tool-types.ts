/**
 * 生成工具的跨层函数签名（kernel 的 per-run 工具解析上下文与 runtime/
 * 工具实现共用）。独立成模块：不 import kernel，避免类型循环。
 */

/** 生成图持久化：临时 URL → 持久 URL（blob 缝，runtime 闭包实现）。 */
export type PersistImageFn = (
  sourceUrl: string,
  mimeType: string,
  prompt: string,
) => Promise<string>;

/** 提交图片生成 job 并等待完成（PGMQ → worker → 落画布，runtime 闭包实现）。 */
export type SubmitImageJobFn = (input: {
  prompt: string;
  title: string;
  model: string;
  aspectRatio: string;
  inputImages?: string[];
  quality?: string;
  /** 画布落点（可选）：运行时的作业回调据此显式指定插入位置。 */
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
}) => Promise<{
  jobId: string;
  elementId?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  error?: string;
}>;

/** 提交视频生成 job 并等待完成（PGMQ → worker → 落画布，runtime 闭包实现）。 */
export type SubmitVideoJobFn = (input: {
  prompt: string;
  model: string;
  title?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  inputImages?: string[];
  inputVideo?: string;
  enableAudio?: boolean;
  /** 画布落点（可选）：运行时的作业回调据此显式指定插入位置。 */
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
}) => Promise<{
  jobId: string;
  elementId?: string;
  videoUrl?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  mimeType?: string;
  error?: string;
}>;
