import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { structuredPatch } from "diff";
import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import { observeBinary } from "./file-bytes.js";
import {
  assertTaskFileWriteAllowed,
  hasTaskFileOperations,
} from "./file-operations.js";
import { encodeText, type FileSnapshot, scanText } from "./file-read.js";
import type {
  BinaryObservation,
  FileCommit,
  FileLimits,
  ReadPageInput,
  TextPage,
} from "./file-types.js";

export interface Observation {
  version: string;
  full: boolean;
  ranges: Array<{ start: number; end: number }>;
}
const observations = new Map<string, Map<string, Observation>>();
const queues = new Map<string, Promise<void>>();
const mutations = new Map<
  string,
  { generation: number; fingerprint: string; result: Promise<unknown> }
>();

/** Call after Task resources have stopped. Foreground Run stops retain Task observations. */
export function forgetTaskFileState(workspaceId: string, taskId: string): void {
  if (hasTaskFileOperations(workspaceId, taskId))
    throw new Error("Task 文件操作仍在运行，请先完成撤销再清理状态");
  const prefix = `${workspaceId}:${taskId}:`;
  for (const key of observations.keys()) {
    if (key.startsWith(prefix)) observations.delete(key);
  }
  for (const key of mutations.keys()) {
    if (key.startsWith(prefix)) mutations.delete(key);
  }
  // Canonical file queues belong to all Tasks; clearing them could admit concurrent writes.
}

async function locked<T>(
  path: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  queues.set(path, tail);
  try {
    if (signal)
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const cancel = () => {
          signal.removeEventListener("abort", cancel);
          reject(signal.reason);
        };
        signal.addEventListener("abort", cancel, { once: true });
        previous.then(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        });
      });
    else await previous;
    signal?.throwIfAborted();
    return await action();
  } finally {
    release();
    void tail.then(() => {
      if (queues.get(path) === tail) queues.delete(path);
    });
  }
}

async function lockedPaths<T>(
  paths: string[],
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const ordered = [...new Set(paths)].sort();
  const acquire = (index: number): Promise<T> => {
    const path = ordered[index];
    return path === undefined
      ? action()
      : locked(path, () => acquire(index + 1), signal);
  };
  return acquire(0);
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const missing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

export class ScopedFileController {
  constructor(
    readonly scope: ScopedFilesystemScope,
    readonly limits: FileLimits,
  ) {}
  currentObservations() {
    const identity = this.scope.describe();
    const key = `${identity.workspaceId}:${identity.taskId}:${this.scope.role}:${this.scope.agentId}:${identity.generation}`;
    const observed = observations.get(key) ?? new Map<string, Observation>();
    observations.set(key, observed);
    return observed;
  }
  remember(
    path: string,
    version: string,
    full: boolean,
    range: { start: number; end: number },
    totalCharacters?: number,
  ) {
    const observed = this.currentObservations();
    const existing = observed.get(path);
    const sorted = [
      ...(existing?.version === version ? existing.ranges : []),
      range,
    ].sort((a, b) => a.start - b.start);
    const ranges: Observation["ranges"] = [];
    for (const entry of sorted) {
      const previous = ranges.at(-1);
      if (previous && previous.end >= entry.start)
        previous.end = Math.max(previous.end, entry.end);
      else ranges.push({ ...entry });
    }
    const completelyRead =
      totalCharacters !== undefined &&
      ranges[0]?.start === 0 &&
      ranges[0].end >= totalCharacters;
    observed.set(path, {
      version,
      full:
        full ||
        completelyRead ||
        (existing?.version === version && existing.full === true),
      ranges,
    });
  }
  async resolveWrite(path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      this.scope.role === "explore" ||
      this.scope.role === "review" ||
      this.scope.describe().sandboxMode === "read-only"
    )
      throw new Error("只读角色禁止写入");
    const result = await this.scope.resolvePath(path, "write");
    assertTaskFileWriteAllowed(this.scope, result);
    signal?.throwIfAborted();
    return result;
  }
  async readPage(input: ReadPageInput): Promise<TextPage> {
    const path = await this.scope.resolvePath(input.path, "read");
    input.signal?.throwIfAborted();
    const result = await scanText(
      path,
      input,
      this.limits.codeReadPageCharacters,
    );
    if ((await this.scope.resolvePath(input.path, "read")) !== path)
      throw new Error("文件路径在读取期间变化");
    input.signal?.throwIfAborted();
    this.remember(
      path,
      result.page.version,
      result.full,
      result.range,
      result.totalCharacters,
    );
    return result.page;
  }
  async load(
    path: string,
    signal?: AbortSignal,
  ): Promise<FileSnapshot | undefined> {
    signal?.throwIfAborted();
    try {
      const canonical = await this.scope.resolvePath(path, "read");
      const result = (
        await scanText(
          canonical,
          { path: canonical, signal },
          Number.POSITIVE_INFINITY,
          this.limits.codeReadMaxBytes,
        )
      ).snapshot;
      if ((await this.scope.resolvePath(path, "read")) !== canonical)
        throw new Error("文件路径在读取期间变化");
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  assertObserved(
    path: string,
    before: FileSnapshot,
    expected: string | undefined,
    full = true,
  ) {
    const observation = this.currentObservations().get(path);
    if (!observation || (full && !observation.full))
      throw new Error(
        full ? "必须先完整读取文件，再覆盖写入" : "必须先读取要编辑的原文范围",
      );
    if (
      observation.version !== before.version ||
      (expected !== undefined && expected !== before.version)
    )
      throw new Error("文件在读取后变化，请重新读取");
    return observation;
  }
  async publish(
    path: string,
    content: string,
    before?: FileSnapshot,
    observation?: Omit<Observation, "version">,
    signal?: AbortSignal,
  ): Promise<FileCommit> {
    signal?.throwIfAborted();
    const bytes = encodeText(content, before);
    if (bytes.length > this.limits.codePatchMaxBytes)
      throw new Error(`写入超过字节上限 ${this.limits.codePatchMaxBytes}`);
    await this.publishBytes(
      path,
      bytes,
      before?.version ?? null,
      before?.mode,
      signal,
    );
    const after = await this.load(path);
    if (!after) throw new Error("提交后文件不可用");
    if (observation)
      this.currentObservations().set(path, {
        ...observation,
        version: after.version,
      });
    else
      this.remember(path, after.version, true, {
        start: 0,
        end: content.length,
      });
    return {
      type: before ? "update" : "create",
      filePath: path,
      content,
      originalFile: before?.text ?? null,
      structuredPatch: structuredPatch(
        path,
        path,
        before?.text ?? "",
        content,
        undefined,
        undefined,
        { context: 0 },
      ).hunks,
      version: after.version,
      userModified: false,
    };
  }
  async publishBytes(
    path: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
    mode?: number,
    signal?: AbortSignal,
  ): Promise<BinaryObservation> {
    signal?.throwIfAborted();
    if (bytes.byteLength > this.limits.codePatchMaxBytes)
      throw new Error("写入超过工作区字节预算");
    if ((await this.resolveWrite(path, signal)) !== path)
      throw new Error("提交路径已变化");
    await mkdir(dirname(path), { recursive: true });
    if ((await this.resolveWrite(path, signal)) !== path)
      throw new Error("提交路径已变化");
    const temporary = join(dirname(path), `.kenfutwork-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", mode);
      try {
        await handle.writeFile(bytes, signal ? { signal } : undefined);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await this.resolveWrite(path, signal)) !== path)
        throw new Error("提交路径已变化");
      const latest = await observeBinary(this.scope, path, signal);
      if (latest.version !== expectedVersion)
        throw new Error("文件在提交前变化，请重新预览");
      signal?.throwIfAborted();
      if (expectedVersion !== null) await rename(temporary, path);
      else await link(temporary, path);
      return await observeBinary(this.scope, path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }
  async replayMutation<T>(
    kind: string,
    input: Record<string, unknown>,
    paths: string[],
    action: () => Promise<T>,
  ): Promise<T> {
    const signal =
      input.signal instanceof AbortSignal ? input.signal : undefined;
    signal?.throwIfAborted();
    const canonical = await Promise.all(
      paths.map((path) => this.resolveWrite(path, signal)),
    );
    if (typeof input.operationId !== "string" || !input.operationId)
      return action();
    const identity = this.scope.describe();
    const key = `${identity.workspaceId}:${identity.taskId}:${this.scope.role}:${this.scope.agentId}:${input.operationId}`;
    const parameters = Object.fromEntries(
      Object.entries(input)
        .filter(
          ([name, value]) =>
            name !== "operationId" && name !== "signal" && value !== undefined,
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ kind, paths: canonical, parameters }))
      .digest("hex");
    const existing = mutations.get(key);
    if (existing) {
      if (existing.generation !== identity.generation)
        throw new Error("授权代际已变化，拒绝重放旧调用");
      if (existing.fingerprint !== fingerprint)
        throw new Error("同一调用 ID 的参数指纹冲突");
      return existing.result as Promise<T>;
    }
    const result = Promise.resolve().then(action);
    mutations.set(key, {
      generation: identity.generation,
      fingerprint,
      result,
    });
    return result;
  }
  withLocks<T>(
    paths: string[],
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return lockedPaths(paths, action, signal);
  }
  async readSnapshot(
    input: string,
    signal?: AbortSignal,
  ): Promise<FileSnapshot> {
    signal?.throwIfAborted();
    const path = await this.scope.resolvePath(input, "read");
    const snapshot = await this.load(path, signal);
    if (!snapshot) throw new Error("文件不存在");
    if ((await this.scope.resolvePath(input, "read")) !== path)
      throw new Error("文件路径在读取期间变化");
    signal?.throwIfAborted();
    this.remember(path, snapshot.version, true, {
      start: 0,
      end: snapshot.text.length,
    });
    return snapshot;
  }
}
