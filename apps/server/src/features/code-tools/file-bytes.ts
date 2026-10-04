import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import type { BinaryObservation } from "./file-types.js";

const missing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

/** Metadata observations stream the entire digest without retaining file bytes or granting model observations. */
export async function observeBinary(
  scope: ScopedFilesystemScope,
  input: string,
  signal?: AbortSignal,
): Promise<BinaryObservation> {
  signal?.throwIfAborted();
  const path = await scope.resolvePath(input, "read");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (missing(error)) return { path, version: null, sizeBytes: 0 };
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("观察目标不是常规文件");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      ...(signal ? { signal } : {}),
    }))
      hash.update(chunk);
    const after = await handle.stat();
    signal?.throwIfAborted();
    const stamp = (info: typeof before) =>
      `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (
      stamp(before) !== stamp(after) ||
      (await scope.resolvePath(input, "read")) !== path
    )
      throw new Error("文件在观察期间变化，请重新预览");
    return {
      path,
      version: createHash("sha256")
        .update(stamp(after))
        .update(hash.digest())
        .digest("hex"),
      sizeBytes: after.size,
      mode: after.mode,
    };
  } finally {
    await handle.close();
  }
}
