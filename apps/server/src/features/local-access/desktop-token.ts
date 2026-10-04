import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

// 256 位随机熵属于凭据格式，不是运行时限额或可调治理值。
const TOKEN_BYTES = 32;
export const LOCAL_ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateLocalAccessToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readToken(path: string): Promise<string | null> {
  let file: FileHandle;
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) {
      throw new Error("本机接入凭据必须是普通文件，不能使用符号链接。");
    }
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isFileError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("本机接入凭据必须是当前用户持有的普通文件。");
    }
    await file.chmod(0o600);
    const token = (await file.readFile("utf8")).trim();
    if (!LOCAL_ACCESS_TOKEN_PATTERN.test(token)) {
      throw new Error("本机接入凭据文件格式无效，请检查数据目录。");
    }
    return token;
  } finally {
    await file.close();
  }
}

/** 临时文件写完后原子发布，硬链接排他创建避免跨进程覆盖已有令牌。 */
export async function ensureDesktopToken(dataDir: string): Promise<string> {
  const directory = join(dataDir, "local-access");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("本机接入目录必须是当前用户持有的普通目录。");
  }
  await chmod(directory, 0o700);
  const path = join(directory, "desktop-token");
  const existing = await readToken(path);
  if (existing) return existing;

  const temporary = join(directory, `.desktop-token-${randomUUID()}`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(generateLocalAccessToken(), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (!isFileError(error, "EEXIST")) throw error;
    }
  } finally {
    await unlink(temporary);
  }
  const token = await readToken(path);
  if (!token) throw new Error("本机接入凭据发布失败。");
  return token;
}
