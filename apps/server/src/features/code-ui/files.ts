import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  type CodeUiWorkspace,
  codeUiFileDirectoryParamsSchema,
  codeUiFileReadParamsSchema,
  type FileEntry,
} from "@kenfutwork/shared";
import { validateWorkDir } from "../projects/work-dir.js";
import { CodeUiRepositoryError } from "./repository.js";

/** 目录选择沿用项目 work_dir 的本机路径校验；正文读取仍走 Project 归属检查。 */
export async function readCodeUiDirectory(
  value: unknown,
): Promise<FileEntry[]> {
  const params = codeUiFileDirectoryParamsSchema.parse(value);
  const verdict = validateWorkDir(params.path);
  if (!verdict.ok) throw new CodeUiRepositoryError("not_found", verdict.reason);
  try {
    const directory = await readdir(verdict.path, { withFileTypes: true });
    const visible = await Promise.all(
      directory
        .filter(
          (entry) =>
            params.includeHidden === true || !entry.name.startsWith("."),
        )
        .map(async (entry): Promise<FileEntry> => {
          const path = join(verdict.path, entry.name);
          const linked = entry.isSymbolicLink();
          const isDirectory = linked
            ? await stat(path)
                .then((target) => target.isDirectory())
                .catch(() => false)
            : entry.isDirectory();
          return {
            name: entry.name,
            path,
            type: isDirectory ? "directory" : "file",
            isSymbolicLink: linked,
          };
        }),
    );
    return visible.sort((left, right) =>
      left.type === right.type
        ? left.name.localeCompare(right.name)
        : left.type === "directory"
          ? -1
          : 1,
    );
  } catch (error) {
    throw new CodeUiRepositoryError(
      "not_found",
      `无法读取目录 ${verdict.path}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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
