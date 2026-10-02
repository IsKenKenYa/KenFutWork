import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  type CodeUiWorkspace,
  codeUiFileReadParamsSchema,
} from "@kenfutwork/shared";
import { CodeUiRepositoryError } from "./repository.js";

async function ownedPath(workspaces: CodeUiWorkspace[], path: string) {
  if (!isAbsolute(path))
    throw new CodeUiRepositoryError("not_found", "文件路径不属于 Code 项目");
  const target = resolve(path);
  for (const workspace of workspaces) {
    const root = resolve(workspace.path);
    if (target !== root && !target.startsWith(root + sep)) continue;
    const [actualRoot, actualTarget] = await Promise.all([
      realpath(root),
      realpath(target),
    ]);
    if (
      actualTarget === actualRoot ||
      actualTarget.startsWith(actualRoot + sep)
    )
      return actualTarget;
    break;
  }
  throw new CodeUiRepositoryError("not_found", "文件路径不属于 Code 项目");
}

/** 原 viewer 读取真实工作目录，归属和 symlink 边界由宿主证明。 */
export async function readCodeUiTextFile(
  workspaces: CodeUiWorkspace[],
  value: unknown,
) {
  const params = codeUiFileReadParamsSchema.parse(value);
  const path = await ownedPath(workspaces, params.path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      throw new CodeUiRepositoryError("not_found", "Code viewer 只能读取文件");
    const offset = params.offset ?? 0;
    const length = Math.min(
      params.length ?? stat.size,
      Math.max(0, stat.size - offset),
    );
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    const isBinary = bytes.includes(0);
    return {
      path: params.path,
      content: isBinary ? "" : bytes.toString("utf8"),
      offset,
      bytesRead,
      totalBytes: stat.size,
      truncated: offset + bytesRead < stat.size,
      isBinary,
    };
  } finally {
    await file.close();
  }
}
