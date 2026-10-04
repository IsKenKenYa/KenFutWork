import { unlink } from "node:fs/promises";
import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import { observeBinary } from "./file-bytes.js";
import { errorText, ScopedFileController } from "./file-controller.js";
import type {
  BinaryFileCommit,
  FileBatchResult,
  FileLimits,
  FileRestoreChange,
} from "./file-types.js";

async function verify(
  scope: ScopedFilesystemScope,
  entries: FileRestoreChange[],
): Promise<void> {
  for (const entry of entries) {
    const state = await observeBinary(scope, entry.path);
    if (state.path !== entry.path || state.version !== entry.expectedVersion)
      throw new Error(`文件在预览后变化：${entry.path}`);
  }
}

async function restoreOne(
  scope: ScopedFilesystemScope,
  controller: ScopedFileController,
  entry: FileRestoreChange,
): Promise<BinaryFileCommit> {
  const path = await controller.resolveWrite(entry.path);
  if (path !== entry.path) throw new Error("恢复路径已变化");
  const before = await observeBinary(scope, path);
  if (before.version !== entry.expectedVersion)
    throw new Error("文件在恢复前变化，请重新预览");
  if (entry.bytes === null) {
    if (before.version === null)
      return { filePath: path, type: "noop", version: null, sizeBytes: 0 };
    if (
      (await controller.resolveWrite(path)) !== path ||
      (await observeBinary(scope, path)).version !== entry.expectedVersion
    )
      throw new Error("文件在删除前变化");
    await unlink(path);
    controller.currentObservations().delete(path);
    return { filePath: path, type: "delete", version: null, sizeBytes: 0 };
  }
  const after = await controller.publishBytes(
    path,
    entry.bytes,
    entry.expectedVersion,
    entry.mode ?? before.mode,
  );
  // User-initiated checkpoint restoration is not a model Read observation.
  controller.currentObservations().delete(path);
  return {
    filePath: path,
    type: before.version === null ? "create" : "update",
    version: after.version,
    sizeBytes: after.sizeBytes,
  };
}

/** Trusted checkpoint consumer only; quiescing the branch is intentionally outside Task operation registration. */
export async function commitBatch<T extends ScopedFilesystemScope>(
  scope: ScopedFilesystemScope,
  limits: FileLimits,
  changes: FileRestoreChange[],
  beforeCommit: () => Promise<T>,
): Promise<FileBatchResult<T>> {
  const files: BinaryFileCommit[] = [];
  const failures: FileBatchResult<T>["failures"] = [];
  let newScope: T | undefined;
  try {
    const normalized = await Promise.all(
      changes.map(async (entry) => ({
        ...entry,
        path: await scope.resolvePath(entry.path, "read"),
      })),
    );
    if (normalized.some((entry, index) => entry.path !== changes[index]?.path))
      throw new Error("预览后恢复路径身份已变化，请重新预览");
    if (
      new Set(normalized.map((entry) => entry.path)).size !== normalized.length
    )
      throw new Error("恢复计划含重复的真实文件");
    if (
      normalized.reduce(
        (size, entry) => size + (entry.bytes?.byteLength ?? 0),
        0,
      ) > limits.codePatchMaxBytes
    )
      throw new Error("恢复计划超过工作区补丁字节预算");
    const coordinator = new ScopedFileController(scope, limits);
    await coordinator.withLocks(
      normalized.map((entry) => entry.path),
      async () => {
        await verify(scope, normalized);
        newScope = await beforeCommit();
        const previous = scope.describe();
        const next = newScope.describe();
        if (
          previous.workspaceId !== next.workspaceId ||
          previous.taskId !== next.taskId ||
          previous.projectId !== next.projectId
        )
          throw new Error("恢复回调返回了不同工作域");
        const fresh = new ScopedFileController(newScope, limits);
        for (const entry of normalized)
          if ((await fresh.resolveWrite(entry.path)) !== entry.path)
            throw new Error("恢复路径或权限已变化");
        await verify(newScope, normalized);
        for (const entry of normalized) {
          try {
            files.push(await restoreOne(newScope, fresh, entry));
          } catch (error) {
            failures.push({ filePath: entry.path, error: errorText(error) });
            break;
          }
        }
      },
    );
  } catch (error) {
    failures.push({
      filePath: changes[files.length]?.path ?? "",
      error: errorText(error),
    });
  }
  return {
    files,
    failures,
    ...(newScope ? { newScope } : {}),
    complete: failures.length === 0 && files.length === changes.length,
  };
}
