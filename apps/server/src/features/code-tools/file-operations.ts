import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import { pathWithin } from "../process-sandbox/policy.js";

interface ActiveFileOperation {
  controller: AbortController;
  finished: Promise<unknown>;
  writeRoots: string[];
}
const active = new Map<string, Set<ActiveFileOperation>>();
const revoking = new Map<string, Promise<void>>();
const taskKey = (workspaceId: string, taskId: string) =>
  `${workspaceId}:${taskId}`;

interface RestoreBarrier {
  key: string;
  projectId: string;
  roots: string[];
}
const restoreBarriers = new Set<RestoreBarrier>();
const restorePermits = new WeakMap<ScopedFilesystemScope, RestoreBarrier>();

export class FileRestoreBarrierError extends Error {
  readonly statusCode = 409;
  readonly code = "restore_busy";
}

export interface TaskFileRestoreLease {
  /** Trusted checkpoint scope only; no serialized/model-visible permit. */
  authorize<T extends ScopedFilesystemScope>(scope: T): T;
  release(): Promise<void>;
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return left.some((path) =>
    right.some((root) => pathWithin(path, root) || pathWithin(root, path)),
  );
}

function writableRoots(scope: ScopedFilesystemScope): string[] {
  const facts = scope.describe();
  if (
    scope.role === "explore" ||
    scope.role === "review" ||
    facts.sandboxMode === "read-only"
  )
    return [];
  return [
    facts.rootDirectory,
    ...facts.additionalDirectories
      .filter((root) => root.access === "read-write")
      .map((root) => root.path),
  ];
}

function assertWriteAdmission(
  scope: ScopedFilesystemScope,
  paths: readonly string[],
): void {
  for (const barrier of restoreBarriers) {
    if (restorePermits.get(scope) === barrier) continue;
    if (overlaps(paths, barrier.roots))
      throw new FileRestoreBarrierError(
        "目录正在恢复并生成恢复后快照，禁止普通文件写入。",
      );
  }
}

export function assertTaskFileWriteAllowed(
  scope: ScopedFilesystemScope,
  path: string,
): void {
  assertWriteAdmission(scope, [path]);
}

/** Held across commitBatch AND postSnapshot. Other Tasks are never canceled. */
export async function acquireTaskFileRestoreBarrier(
  scope: ScopedFilesystemScope,
  roots: readonly string[],
): Promise<TaskFileRestoreLease> {
  if (!roots.length)
    throw new FileRestoreBarrierError("恢复屏障至少需要一个真实可写目录。");
  const canonical = [
    ...new Set(
      await Promise.all(roots.map((root) => scope.resolvePath(root, "write"))),
    ),
  ];
  const identity = scope.describe();
  const key = taskKey(identity.workspaceId, identity.taskId);
  for (const barrier of restoreBarriers)
    if (overlaps(canonical, barrier.roots))
      throw new FileRestoreBarrierError("另一个文件恢复屏障已占用该目录。");
  for (const [owner, entries] of active) {
    if (owner === key) continue;
    if ([...entries].some((entry) => overlaps(canonical, entry.writeRoots)))
      throw new FileRestoreBarrierError(
        "其他 Task 在相交的可写目录中有文件操作，不能开始恢复。",
      );
  }
  const barrier: RestoreBarrier = {
    key,
    projectId: identity.projectId,
    roots: canonical,
  };
  restoreBarriers.add(barrier);
  let released = false;
  return {
    authorize(next) {
      const facts = next.describe();
      if (
        released ||
        taskKey(facts.workspaceId, facts.taskId) !== barrier.key ||
        facts.projectId !== barrier.projectId
      )
        throw new FileRestoreBarrierError(
          "恢复 permit 不属于该 Task 的有效屏障。",
        );
      restorePermits.set(next, barrier);
      return next;
    },
    async release() {
      if (released) return;
      released = true;
      restoreBarriers.delete(barrier);
    },
  };
}

/** A canceled flag is not completion: callers await each operation's resource cleanup. */
export function revokeTaskFileOperations(
  workspaceId: string,
  taskId: string,
): Promise<void> {
  const key = taskKey(workspaceId, taskId);
  const existing = revoking.get(key);
  if (existing) return existing;
  const entries = [...(active.get(key) ?? [])];
  for (const entry of entries)
    entry.controller.abort(
      new DOMException("Task 文件操作授权已撤销", "AbortError"),
    );
  const finished = Promise.allSettled(entries.map((entry) => entry.finished))
    .then(() => {})
    .finally(() => {
      if (revoking.get(key) === finished) revoking.delete(key);
    });
  revoking.set(key, finished);
  return finished;
}

export function hasTaskFileOperations(
  workspaceId: string,
  taskId: string,
): boolean {
  const key = taskKey(workspaceId, taskId);
  return (active.get(key)?.size ?? 0) > 0 || revoking.has(key);
}

export function runFileOperation<T>(
  scope: ScopedFilesystemScope,
  parentSignal: AbortSignal | undefined,
  action: (signal: AbortSignal) => Promise<T>,
  operation: "read" | "write" = "read",
): Promise<T> {
  const identity = scope.describe();
  const key = taskKey(identity.workspaceId, identity.taskId);
  if (revoking.has(key))
    return Promise.reject(new Error("Task 文件作用域正在撤销，禁止新操作"));
  if (parentSignal?.aborted) return Promise.reject(parentSignal.reason);
  const writeRoots = operation === "write" ? writableRoots(scope) : [];
  try {
    assertWriteAdmission(scope, writeRoots);
  } catch (error) {
    return Promise.reject(error);
  }
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const entries = active.get(key) ?? new Set<ActiveFileOperation>();
  const entry: ActiveFileOperation = {
    controller,
    finished: Promise.resolve(),
    writeRoots,
  };
  const finished = Promise.resolve()
    .then(() => {
      signal.throwIfAborted();
      assertWriteAdmission(scope, writeRoots);
      return action(signal);
    })
    .finally(() => {
      entries.delete(entry);
      if (!entries.size && active.get(key) === entries) active.delete(key);
    });
  entry.finished = finished;
  entries.add(entry);
  active.set(key, entries);
  return finished;
}
