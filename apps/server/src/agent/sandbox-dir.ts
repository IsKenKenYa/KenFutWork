import { resolve } from "node:path";

/**
 * 画布 → 沙箱工作目录的**唯一**解析处。
 *
 * 为什么单独抽出来：这个目录有两类消费者——agent 后端（文件工具与 `execute` 的 cwd）
 * 与需要在该目录里操作的能力（如 git 分支操作）。若各算各的，一旦命名规则或根目录
 * 来源漂移，「agent 在 A 目录干活、X 在 B 目录操作」就会静默发生（本项目已有一次
 * 文件系统割裂的历史事故）。故判定只有一处，两边共用。
 *
 * 目录名来自画布 id（uuid），仍做防御性清洗防路径穿越。
 */
export const DEFAULT_SANDBOX_ROOT = "/tmp/loomic-sandbox";

export function sanitizeCanvasIdForPath(canvasId: string): string {
  return canvasId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** 返回画布沙箱目录（未做 mkdir / realpath，由调用方按需处理）。 */
export function resolveSandboxDir(
  canvasId: string,
  sandboxRoot?: string,
): string {
  const root = resolve(sandboxRoot ?? DEFAULT_SANDBOX_ROOT);
  return resolve(root, sanitizeCanvasIdForPath(canvasId));
}
