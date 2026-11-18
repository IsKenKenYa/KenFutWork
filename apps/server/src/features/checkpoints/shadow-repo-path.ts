import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * 影子仓库目录名（**短布局**）：`<taskId>-<rootHash16>.git`。
 *
 * 属主唯一在本文件：checkpoint-service 的仓库解析、process-sandbox 的 checkpoint
 * 私有写根、local-instance 的数据目录迁移重绑，三处必须用同一公式。
 * 2026-10-13 实测事故：短布局改造（Windows 长路径）后，process-sandbox/plugin 与
 * root-binding 仍按旧三层布局算路径——沙箱 checkpoint 私有 spawn 的 `realpath`
 * 直接 ENOENT，打包冒烟的「持久 shadow checkpoint」一步恒为空列表。
 *
 * 为什么是短名而不是「三层 UUID + 64 位摘要」：临时目录 / AppData 前缀一叠就
 * 230+ 字符，Windows 上 git 自己都打不开（`fatal: '$GIT_DIR' too big` /
 * `Filename too long`；`core.longpaths=true` 治不了）。旧布局仓库由
 * checkpoint-service 原地搬家兼容，本公式只负责新仓库。
 */
export function shadowRepositoryName(taskId: string, workTree: string): string {
  const digest = createHash("sha256").update(workTree).digest("hex");
  return `${taskId}-${digest.slice(0, 16)}.git`;
}

/** 影子仓库目录的绝对路径：`<checkpointRoot>/<taskId>-<rootHash16>.git`。 */
export function shadowRepositoryPath(
  checkpointRoot: string,
  taskId: string,
  workTree: string,
): string {
  return join(checkpointRoot, shadowRepositoryName(taskId, workTree));
}
