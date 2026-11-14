import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { MediaDriverRegistryError } from "./errors.js";

export async function privateDirectory(
  dataDir: string,
  parts: string[],
  create: boolean,
) {
  let current = await realpath(dataDir);
  for (const part of parts) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      }
    }
    const state = await lstat(current);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new MediaDriverRegistryError(
        "media_driver_storage_error",
        "应用数据目录不可用，请恢复目录权限",
        503,
      );
  }
  return current;
}

export async function writePrivateFile(path: string, contents: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
