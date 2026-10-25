import { createHash } from "node:crypto";
import type { SandboxProcessRequest as ProcessSpawnRequest } from "./types.js";

/** 沿用 helper 的请求指纹；本地取消信号不属于可重放的执行参数。 */
export function processInvocationFingerprint(
  request: ProcessSpawnRequest,
  internalWriteRoots: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ request, internalWriteRoots }))
    .digest("hex");
}
