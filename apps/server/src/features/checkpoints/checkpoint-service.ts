import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitSource } from "../code-git/code-git-service.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type {
  CheckpointKind,
  CheckpointRepository,
  CheckpointRow,
  DirectorySnapshot,
} from "./repository.js";
import {
  SHADOW_EXCLUDES,
  type ShadowGitClient,
  type ShadowNumstatFile,
} from "./shadow-git-client.js";

export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export class CodeCheckpointError extends Error {
  constructor(
    readonly code: "not_found" | "git_unavailable" | "checkpoint_failed",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "CodeCheckpointError";
  }
}
export interface CheckpointFileChange extends ShadowNumstatFile {
  rootDirectory: string;
}
export interface CheckpointPreview {
  targetSha: string;
  expectedVersion: string;
  files: CheckpointFileChange[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}
export interface RestoreEntry {
  path: string;
  bytes: Uint8Array | null;
  expectedVersion: string | null;
  mode?: number;
}
export interface CheckpointFileTransactions {
  observe(
    scope: ExecutionScopeHandle,
    path: string,
  ): Promise<{ path: string; version: string | null }>;
  commit(
    scope: ExecutionScopeHandle,
    entries: RestoreEntry[],
    beforeCommit: () => Promise<ExecutionScopeHandle>,
  ): Promise<ExecutionScopeHandle>;
}
export interface CheckpointRestoreBarrier {
  authorize(scope: ExecutionScopeHandle): ExecutionScopeHandle;
  release(): Promise<void>;
}
type ScopeInput = { scope: ExecutionScopeHandle; actor: LocalActor };
type CheckpointInput = ScopeInput & { checkpointId: string };
type FileTarget = {
  path?: string | undefined;
  rootDirectory?: string | undefined;
};
export type TurnBoundaryPhase = "pre" | "post";
export interface TurnBoundaryCapture {
  phase: TurnBoundaryPhase;
  created: CheckpointRow | null;
  /** 本次实际目录shadow版本的有效引用；只有所有目录都没有shadow引用时为null。 */
  effective: CheckpointRow | null;
}
export interface CheckpointService {
  forgetTask(instanceId: string, taskId: string): void;
  captureTurnBoundary(
    input: ScopeInput & { runId: string; phase: TurnBoundaryPhase },
  ): Promise<TurnBoundaryCapture>;
  beforeTurn(
    input: ScopeInput & { runId: string },
  ): Promise<CheckpointRow | null>;
  afterTurn(
    input: ScopeInput & { runId: string },
  ): Promise<CheckpointRow | null>;
  list(input: ScopeInput): Promise<CheckpointRow[]>;
  diffFor(
    input: CheckpointInput & FileTarget,
  ): Promise<{ text: string; files: CheckpointFileChange[] }>;
  turnFiles(input: CheckpointInput): Promise<{ files: CheckpointFileChange[] }>;
  /** 精确文件引用；字节只交可信恢复消费者，不把解码文本当原文件。 */
  readFileSnapshot(
    input: CheckpointInput & { path: string },
  ): Promise<{ bytes: Uint8Array | null; mode?: number }>;
  previewRestore(
    input: CheckpointInput & FileTarget,
  ): Promise<CheckpointPreview>;
  restore(
    input: CheckpointInput & { expectedVersion: string },
  ): Promise<CheckpointRow>;
  restoreFile(
    input: CheckpointInput & {
      expectedVersion: string;
      path: string;
      rootDirectory?: string | undefined;
    },
  ): Promise<CheckpointRow>;
}
function within(root: string, path: string): boolean {
  const tail = relative(root, path);
  return (
    tail === "" ||
    (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`))
  );
}
const totals = (files: readonly ShadowNumstatFile[]) => ({
  filesChanged: files.length,
  insertions: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
  deletions: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
});
function requireRelative(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.replaceAll("\\", "/").split("/").includes("..") ||
    path.includes("\0")
  )
    throw new CodeCheckpointError(
      "checkpoint_failed",
      "文件路径必须位于检查点目录内。",
      400,
    );
  return path;
}
async function stagedFiles(root: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        if (!entry.isFile())
          throw new CodeCheckpointError(
            "checkpoint_failed",
            "恢复暂不支持符号链接或特殊文件。",
            409,
          );
        files.push(relative(root, path));
        if (files.length > maxFiles)
          throw new CodeCheckpointError(
            "checkpoint_failed",
            "恢复文件数量超过工作区配置上限。",
            409,
          );
      }
    }
  };
  await visit(root);
  return files;
}

/** Task 目录快照与恢复：Git 仅生成私有快照；用户文件由共享版本化提交器修改。 */
export function createCheckpointService(options: {
  repository: CheckpointRepository;
  gitForScope: (
    scope: ExecutionScopeHandle,
    actor: LocalActor,
  ) => Promise<ShadowGitClient>;
  gitSource: GitSource;
  checkpointRoot: string;
  files: CheckpointFileTransactions;
  acquireRestoreBarrier: (
    scope: ExecutionScopeHandle,
    roots: readonly string[],
  ) => Promise<CheckpointRestoreBarrier>;
  onBeforeRestore: (
    scope: ExecutionScopeHandle,
    actor: LocalActor,
  ) => Promise<ExecutionScopeHandle>;
  onAfterRestore: (
    scope: ExecutionScopeHandle,
    actor: LocalActor,
    success: boolean,
  ) => Promise<void>;
}): CheckpointService {
  const locks = new Map<string, Promise<unknown>>();
  const previews = new Map<
    string,
    {
      token: string;
      checkpointId: string;
      generation: number;
      path?: string;
      rootDirectory?: string;
      entries: RestoreEntry[];
    }
  >();
  const identityKey = (scope: ExecutionScopeHandle) =>
    `${scope.describe().instanceId}:${scope.describe().taskId}`;
  const gitDirectory = (scope: ExecutionScopeHandle, root: string) => {
    const id = scope.describe();
    return join(
      options.checkpointRoot,
      id.instanceId,
      id.projectId,
      `${id.taskId}.git`,
      createHash("sha256").update(root).digest("hex"),
    );
  };
  const excludedPathsFor = (
    scope: ExecutionScopeHandle,
    root: string,
    snapshots: readonly DirectorySnapshot[] = [],
  ) =>
    [
      ...new Set([
        ...scope.describe().additionalDirectories.map((entry) => entry.path),
        ...snapshots.map((entry) => entry.rootDirectory),
        resolve(options.checkpointRoot),
      ]),
    ]
      .filter((path) => path !== root && within(root, path))
      .map((path) => relative(root, path).split(sep).join("/"));
  const checked = async <T>(
    input: ScopeInput,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (options.gitSource === "unavailable")
      throw new CodeCheckpointError(
        "git_unavailable",
        "运行环境没有 Git，检查点不可用。",
        503,
      );
    await input.scope.resolvePath(".", "read");
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CodeCheckpointError) throw error;
      throw new CodeCheckpointError(
        "checkpoint_failed",
        error instanceof Error ? error.message : String(error),
        409,
      );
    }
  };
  const exclusive = async <T>(
    scope: ExecutionScopeHandle,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const key = identityKey(scope);
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    locks.set(key, current);
    try {
      return await current;
    } finally {
      if (locks.get(key) === current) locks.delete(key);
    }
  };
  const rowFor = async (input: CheckpointInput) => {
    const identity = input.scope.describe();
    const row = await options.repository.getById(
      identity.instanceId,
      input.checkpointId,
    );
    if (
      !row ||
      row.taskId !== identity.taskId ||
      row.projectId !== identity.projectId ||
      row.rootDirectory !== identity.rootDirectory
    )
      throw new CodeCheckpointError(
        "not_found",
        "检查点不属于当前 Task。",
        404,
      );
    return row;
  };
  const rootsFor = (scope: ExecutionScopeHandle) => {
    const identity = scope.describe();
    return [
      identity.rootDirectory,
      ...identity.additionalDirectories
        .filter((entry) => entry.access === "read-write")
        .map((entry) => entry.path),
    ];
  };
  const captureSnapshot = async (
    input: ScopeInput & { runId: string | null },
    kind: CheckpointKind,
    label: string,
  ): Promise<Omit<TurnBoundaryCapture, "phase">> => {
    const identity = input.scope.describe();
    const previous = (
      await options.repository.listByTask(identity.instanceId, identity.taskId)
    ).at(-1);
    const git = await options.gitForScope(input.scope, input.actor);
    const directorySnapshots: DirectorySnapshot[] = [];
    for (const rootDirectory of [...new Set(rootsFor(input.scope))]) {
      await input.scope.resolvePath(rootDirectory, "read");
      const gitDir = gitDirectory(input.scope, rootDirectory);
      await mkdir(gitDir, { recursive: true });
      const nested = excludedPathsFor(input.scope, rootDirectory);
      const excludes = [
        ...SHADOW_EXCLUDES,
        ...nested.map((path) => `/${path.replace(/[\\*?[\]#! ]/g, "\\$&")}/`),
      ];
      const directory = {
        gitDir,
        workTree: rootDirectory,
        excludedPaths: excludedPathsFor(input.scope, rootDirectory),
      };
      await git.ensureRepo({ ...directory, excludes });
      const committed = await git.commitSnapshot({
        ...directory,
        message: label,
      });
      const shadowCommit = committed?.sha ?? (await git.head(directory));
      if (!shadowCommit) continue;
      directorySnapshots.push({ rootDirectory, shadowCommit });
    }
    if (!directorySnapshots.length) return { created: null, effective: null };
    const effective = await options.repository.getByVersion(
      identity.instanceId,
      identity.taskId,
      {
        projectId: identity.projectId,
        rootDirectory: identity.rootDirectory,
        directorySnapshots,
      },
    );
    if (effective) return { created: null, effective };
    const files: CheckpointFileChange[] = [];
    for (const { rootDirectory, shadowCommit } of directorySnapshots) {
      const from =
        previous?.directorySnapshots.find(
          (entry) => entry.rootDirectory === rootDirectory,
        )?.shadowCommit ?? EMPTY_TREE_SHA;
      const directory = {
        gitDir: gitDirectory(input.scope, rootDirectory),
        workTree: rootDirectory,
        excludedPaths: excludedPathsFor(input.scope, rootDirectory),
      };
      files.push(
        ...(await git.numstat({ ...directory, from, to: shadowCommit })).map(
          (entry) => ({ ...entry, rootDirectory }),
        ),
      );
    }
    const row: CheckpointRow = {
      id: randomUUID(),
      instanceId: identity.instanceId,
      projectId: identity.projectId,
      taskId: identity.taskId,
      rootDirectory: identity.rootDirectory,
      directorySnapshots,
      runId: input.runId,
      kind,
      label,
      shadowCommit: directorySnapshots[0]!.shadowCommit,
      ...totals(files),
      createdAt: new Date().toISOString(),
    };
    await input.scope.resolvePath(".", "read");
    await options.repository.insert(row);
    return { created: row, effective: row };
  };
  const snapshot = async (
    input: ScopeInput & { runId: string | null },
    kind: CheckpointKind,
    label: string,
  ) => (await captureSnapshot(input, kind, label)).created;
  const changes = async (
    input: CheckpointInput & FileTarget,
    text: boolean,
  ) => {
    const row = await rowFor(input);
    const identity = input.scope.describe();
    const previous = await options.repository.getPrevious(
      identity.instanceId,
      identity.taskId,
      row.createdAt,
    );
    const git = await options.gitForScope(input.scope, input.actor);
    const files: CheckpointFileChange[] = [];
    const diff: string[] = [];
    const targetRoot = input.path
      ? (input.rootDirectory ?? identity.rootDirectory)
      : undefined;
    if (
      targetRoot &&
      !row.directorySnapshots.some(
        (entry) => entry.rootDirectory === targetRoot,
      )
    )
      throw new CodeCheckpointError(
        "not_found",
        "文件目录不属于该检查点。",
        404,
      );
    for (const directory of row.directorySnapshots) {
      if (targetRoot && directory.rootDirectory !== targetRoot) continue;
      await input.scope.resolvePath(directory.rootDirectory, "read");
      const from =
        previous?.directorySnapshots.find(
          (entry) => entry.rootDirectory === directory.rootDirectory,
        )?.shadowCommit ?? EMPTY_TREE_SHA;
      const scope = {
        gitDir: gitDirectory(input.scope, directory.rootDirectory),
        workTree: directory.rootDirectory,
        from,
        to: directory.shadowCommit,
      };
      const entries = (await git.numstat(scope)).filter(
        (entry) => !input.path || entry.path === input.path,
      );
      files.push(
        ...entries.map((entry) => ({
          ...entry,
          rootDirectory: directory.rootDirectory,
        })),
      );
      if (text)
        diff.push(
          await git.diffText({
            ...scope,
            ...(input.path ? { path: requireRelative(input.path) } : {}),
          }),
        );
    }
    return { text: diff.join("\n"), files };
  };
  const preview = async (
    input: CheckpointInput & FileTarget,
  ): Promise<CheckpointPreview> => {
    const row = await rowFor(input);
    const identity = input.scope.describe();
    const git = await options.gitForScope(input.scope, input.actor);
    const entries: RestoreEntry[] = [];
    const files: CheckpointFileChange[] = [];
    let totalBytes = 0;
    const targetRoot = input.path
      ? (input.rootDirectory ?? identity.rootDirectory)
      : undefined;
    if (
      targetRoot &&
      !row.directorySnapshots.some(
        (entry) => entry.rootDirectory === targetRoot,
      )
    )
      throw new CodeCheckpointError(
        "not_found",
        "文件目录不属于该检查点。",
        404,
      );
    const previous = input.path
      ? await options.repository.getPrevious(
          identity.instanceId,
          identity.taskId,
          row.createdAt,
        )
      : null;
    for (const directory of row.directorySnapshots) {
      if (targetRoot && directory.rootDirectory !== targetRoot) continue;
      await input.scope.resolvePath(directory.rootDirectory, "write");
      const gitDir = gitDirectory(input.scope, directory.rootDirectory);
      const workTree = directory.rootDirectory;
      const excludedPaths = excludedPathsFor(
        input.scope,
        workTree,
        row.directorySnapshots,
      );
      const protectedPath = (path: string) =>
        excludedPaths.some(
          (excluded) => path === excluded || path.startsWith(`${excluded}/`),
        );
      const sha = input.path
        ? (previous?.directorySnapshots.find(
            (entry) => entry.rootDirectory === workTree,
          )?.shadowCommit ?? EMPTY_TREE_SHA)
        : directory.shadowCommit;
      const changed = (
        await git.changedAgainst({ gitDir, workTree, sha, excludedPaths })
      ).filter(
        (entry) =>
          !protectedPath(entry.path) &&
          (!input.path || entry.path === input.path),
      );
      files.push(
        ...changed.map((entry) => ({ ...entry, rootDirectory: workTree })),
      );
      const currentPaths = await git.currentPaths({
        gitDir,
        workTree,
        excludedPaths,
      });
      const stagingDirectory = join(gitDir, `restore-${randomUUID()}`);
      await mkdir(stagingDirectory, { recursive: true });
      try {
        await git.materialize({ gitDir, workTree, sha, stagingDirectory });
        const paths = [
          ...new Set([
            ...currentPaths,
            ...(await stagedFiles(
              stagingDirectory,
              input.scope.backend.limits.codeSearchMaxResults,
            )),
          ]),
        ].filter(
          (path) =>
            !protectedPath(path.split(sep).join("/")) &&
            (!input.path || path === input.path),
        );
        for (const path of paths) {
          requireRelative(path);
          const target = resolve(workTree, path);
          if ((await input.scope.resolvePath(target, "write")) !== target)
            throw new CodeCheckpointError(
              "checkpoint_failed",
              "恢复路径当前包含符号链接或已改变，请先处理路径冲突。",
              409,
            );
          const current = await lstat(target).catch((error: unknown) => {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return null;
            throw error;
          });
          if (current && !current.isFile())
            throw new CodeCheckpointError(
              "checkpoint_failed",
              "工作目录中的恢复路径类型已改变。",
              409,
            );
          const staged = join(stagingDirectory, path);
          const stat = await lstat(staged).catch((error: unknown) => {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return null;
            throw error;
          });
          if (
            stat &&
            (!stat.isFile() ||
              stat.size > input.scope.backend.limits.codePatchMaxBytes)
          )
            throw new CodeCheckpointError(
              "checkpoint_failed",
              "恢复文件类型或字节数超过允许范围。",
              409,
            );
          const bytes = stat ? new Uint8Array(await readFile(staged)) : null;
          totalBytes += bytes?.byteLength ?? 0;
          if (totalBytes > input.scope.backend.limits.codePatchMaxBytes)
            throw new CodeCheckpointError(
              "checkpoint_failed",
              "恢复内容总字节数超过工作区配置上限。",
              409,
            );
          const observation = await options.files.observe(input.scope, target);
          if (observation.path !== target)
            throw new CodeCheckpointError(
              "checkpoint_failed",
              "恢复路径在预览期间变化。",
              409,
            );
          entries.push({
            path: observation.path,
            bytes,
            expectedVersion: observation.version,
            ...(stat ? { mode: stat.mode } : {}),
          });
          if (entries.length > input.scope.backend.limits.codeSearchMaxResults)
            throw new CodeCheckpointError(
              "checkpoint_failed",
              "恢复文件数量超过配置上限。",
              409,
            );
        }
      } finally {
        await rm(stagingDirectory, { recursive: true, force: true });
      }
    }
    const token = randomUUID();
    await input.scope.resolvePath(".", "read");
    previews.set(identityKey(input.scope), {
      token,
      checkpointId: row.id,
      generation: identity.generation,
      entries,
      ...(input.path ? { path: input.path, rootDirectory: targetRoot! } : {}),
    });
    return {
      targetSha: row.shadowCommit,
      expectedVersion: token,
      files,
      ...totals(files),
    };
  };
  const readFileSnapshot = async (
    input: CheckpointInput & { path: string },
  ) => {
    const row = await rowFor(input);
    const canonical = await input.scope.resolvePath(input.path, "read");
    const directory = [...row.directorySnapshots]
      .sort(
        (left, right) => right.rootDirectory.length - left.rootDirectory.length,
      )
      .find((entry) => within(entry.rootDirectory, canonical));
    if (!directory || canonical === directory.rootDirectory)
      throw new CodeCheckpointError(
        "not_found",
        "文件不属于该检查点的授权目录。",
        404,
      );
    const path = requireRelative(relative(directory.rootDirectory, canonical));
    const gitDir = gitDirectory(input.scope, directory.rootDirectory);
    const stagingDirectory = join(gitDir, `read-${randomUUID()}`);
    await mkdir(stagingDirectory, { recursive: true });
    try {
      const git = await options.gitForScope(input.scope, input.actor);
      await git.materialize({
        gitDir,
        workTree: directory.rootDirectory,
        sha: directory.shadowCommit,
        stagingDirectory,
        path,
      });
      const staged = join(stagingDirectory, path);
      const stat = await lstat(staged).catch((error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      });
      if (
        stat &&
        (!stat.isFile() ||
          stat.size > input.scope.backend.limits.codePatchMaxBytes)
      )
        throw new CodeCheckpointError(
          "checkpoint_failed",
          "检查点文件类型或字节数超过允许范围。",
          409,
        );
      const bytes = stat ? new Uint8Array(await readFile(staged)) : null;
      if ((await input.scope.resolvePath(input.path, "read")) !== canonical)
        throw new CodeCheckpointError(
          "checkpoint_failed",
          "文件身份在读取检查点期间变化。",
          409,
        );
      return { bytes, ...(stat ? { mode: stat.mode } : {}) };
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  };
  const restore = async (
    input: CheckpointInput & { expectedVersion: string } & FileTarget,
  ) => {
    const row = await rowFor(input);
    const key = identityKey(input.scope);
    const plan = previews.get(key);
    const targetRoot = input.path
      ? (input.rootDirectory ?? input.scope.describe().rootDirectory)
      : undefined;
    if (
      !plan ||
      plan.token !== input.expectedVersion ||
      plan.checkpointId !== row.id ||
      plan.generation !== input.scope.describe().generation ||
      plan.path !== input.path ||
      plan.rootDirectory !== targetRoot
    )
      throw new CodeCheckpointError(
        "checkpoint_failed",
        "恢复预览已过期，请重新预览。",
        409,
      );
    let restoringScope: ExecutionScopeHandle | null = null;
    const barrier = await options.acquireRestoreBarrier(
      input.scope,
      rootsFor(input.scope),
    );
    let released = false;
    try {
      const nextScope = await options.files.commit(
        input.scope,
        plan.entries,
        async () => {
          restoringScope = barrier.authorize(
            await options.onBeforeRestore(input.scope, input.actor),
          );
          return restoringScope;
        },
      );
      const restored =
        (await snapshot(
          { scope: nextScope, actor: input.actor, runId: null },
          "restore",
          input.path ? "文件恢复点" : "回滚恢复点",
        )) ?? row;
      await barrier.release();
      released = true;
      await options.onAfterRestore(nextScope, input.actor, true);
      previews.delete(key);
      return restored;
    } catch (error) {
      if (restoringScope)
        await options.onAfterRestore(restoringScope, input.actor, false);
      throw error;
    } finally {
      if (!released) await barrier.release();
    }
  };
  return {
    forgetTask: (instanceId, taskId) => {
      previews.delete(`${instanceId}:${taskId}`);
    },
    captureTurnBoundary: (input) =>
      checked(input, () =>
        exclusive(input.scope, async () => ({
          ...(await captureSnapshot(
            input,
            "turn",
            input.phase === "pre" ? "轮次开始快照" : "轮次结束快照",
          )),
          phase: input.phase,
        })),
      ),
    beforeTurn: (input) =>
      checked(input, () =>
        exclusive(input.scope, () => snapshot(input, "turn", "轮次开始快照")),
      ),
    afterTurn: (input) =>
      checked(input, () =>
        exclusive(input.scope, () => snapshot(input, "turn", "轮次结束快照")),
      ),
    list: (input) =>
      checked(input, () =>
        options.repository.listByTask(
          input.scope.describe().instanceId,
          input.scope.describe().taskId,
        ),
      ),
    diffFor: (input) =>
      checked(input, () => exclusive(input.scope, () => changes(input, true))),
    turnFiles: (input) =>
      checked(input, () => exclusive(input.scope, () => changes(input, false))),
    readFileSnapshot: (input) =>
      checked(input, () =>
        exclusive(input.scope, () => readFileSnapshot(input)),
      ),
    previewRestore: (input) =>
      checked(input, () => exclusive(input.scope, () => preview(input))),
    restore: (input) =>
      checked(input, () => exclusive(input.scope, () => restore(input))),
    restoreFile: (input) =>
      checked(input, () => exclusive(input.scope, () => restore(input))),
  };
}
