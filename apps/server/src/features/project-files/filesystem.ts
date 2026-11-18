import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readBoundedBlob } from "../blob/providers/local-fs.js";
import { ProjectFileError } from "./types.js";

export const fingerprintOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function validateRelativePath(path: string): void {
  const parts = path.split("/");
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    parts.some((part) => !part || part === "." || part === "..") ||
    parts[0] === ".kenfutwork"
  )
    throw new ProjectFileError(
      "invalid_path",
      "素材路径必须位于项目目录内，不能覆盖应用管理文件。",
      400,
    );
}
export async function checkedFilePath(
  root: string,
  relativePath: string,
  create: boolean,
): Promise<string> {
  validateRelativePath(relativePath);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ProjectFileError("invalid_path", "项目目录不可用。", 400);
  let path = await realpath(root);
  const parts = relativePath.split("/");
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    try {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new ProjectFileError(
          "invalid_path",
          "素材目录包含符号链接或不可用路径。",
          400,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create)
        throw new ProjectFileError(
          "file_missing",
          "项目素材目录缺失，请恢复已登记的文件。",
        );
      try {
        await mkdir(path);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
          throw mkdirError;
      }
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new ProjectFileError("invalid_path", "素材目录不可用。", 400);
    }
  }
  const fileName = parts.at(-1);
  if (!fileName)
    throw new ProjectFileError("invalid_path", "素材路径无效。", 400);
  return join(path, fileName);
}
export async function readProjectFile(
  path: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    signal?.throwIfAborted();
    const bytes = await readBoundedBlob(path, maxBytes);
    signal?.throwIfAborted();
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ProjectFileError(
        "file_missing",
        "项目素材文件缺失，请恢复已登记的文件。",
      );
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new ProjectFileError(
        "invalid_path",
        "素材文件不能是符号链接。",
        400,
      );
    throw error;
  }
}
export async function assertProjectFileExists(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new ProjectFileError(
        "invalid_path",
        "素材路径必须是普通文件。",
        400,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ProjectFileError(
        "file_missing",
        "项目素材文件缺失，请恢复已登记的文件。",
      );
    throw error;
  }
}
export async function publishFile(
  path: string,
  bytes: Uint8Array,
  beforePublish: () => Promise<void>,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforePublish();
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (fingerprintOf(await readProjectFile(path)) !== fingerprintOf(bytes))
        throw new ProjectFileError(
          "file_conflict",
          "目标文件已存在且内容不同，不会覆盖。",
        );
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
