/**
 * zcode 照搬（部分）：`@/workspace-file-tree/model` 中照搬组件实际消费的切片。
 * 来源：references/zcode/packages/ui/src/workspace-file-tree/model.ts
 * 许可证：Apache-2.0（zcode）。
 * 适配：只保留路径相对化纯函数（文件树数据模型不搬——我们的工作区文件树
 * 由服务端 API 供数，不进入 zcode 渲染层）。
 */

import { getPathLeaf } from "../lib/path.js";

function normalizeForRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function getWorkspaceFileRelativePath(
  workspacePath: string,
  filePath: string,
): string {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedFilePath = normalizeForRelativePath(filePath);

  if (normalizedWorkspacePath === normalizedFilePath) {
    return ".";
  }

  const workspacePrefix = `${normalizedWorkspacePath}/`;
  if (normalizedFilePath.startsWith(workspacePrefix)) {
    return normalizedFilePath.slice(workspacePrefix.length);
  }

  return getPathLeaf(filePath);
}

export function areWorkspaceFilePathsEqual(
  leftPath: string,
  rightPath: string,
): boolean {
  return (
    normalizeForRelativePath(leftPath) === normalizeForRelativePath(rightPath)
  );
}

export function isWorkspaceFilePathInside(
  workspacePath: string,
  filePath: string,
): boolean {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedFilePath = normalizeForRelativePath(filePath);
  return (
    normalizedFilePath === normalizedWorkspacePath ||
    normalizedFilePath.startsWith(`${normalizedWorkspacePath}/`)
  );
}
