import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { sanitizeCanvasIdForPath } from "../../agent/sandbox-dir.js";
import type { CanvasRepository } from "../canvas/repository.js";
import type { GitSource } from "../code-git/code-git-service.js";
import type {
  CheckpointKind,
  CheckpointRepository,
  CheckpointRow,
} from "./repository.js";
import {
  SHADOW_EXCLUDES,
  type ShadowGitClient,
  type ShadowNumstatFile,
} from "./shadow-git-client.js";

/**
 * 检查点服务（Code 模式）：把影子 git（切片1）包装成「轮次快照 / 恢复」的产品能力。
 *
 * 能力缝三元组：本文件是 Service Definition（`CheckpointService`）+ Provider
 * （`createCheckpointService`）；Consumer 在切片3（agent runtime 钩子：beforeTurn/
 * afterTurn）与切片4（HTTP 路由：list/diffFor/previewRestore/restore）。
 *
 * 两条调用路径的鉴权口径：
 * - runtime 钩子（beforeTurn/afterTurn）无用户身份，直接按 canvasId 工作（服务端
 *   内部调用，画布 id 来自本次 run）；workspace 由画布反查（`findWorkspaceIdByCanvas`）。
 * - HTTP 路径带 `workspaceId`（切片4 的路由已从 viewer 解析出来），本服务再做
 *   canvas 归属校验（画布必须属于该工作区，否则 404，不给枚举信号），目录一律经
 *   注入的 `resolveSandboxDirFn` 解析——与 agent 后端同一处判定。
 */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class CodeCheckpointError extends Error {
  readonly code: "not_found" | "git_unavailable" | "checkpoint_failed";
  readonly statusCode: number;

  constructor(
    code: CodeCheckpointError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "CodeCheckpointError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** 恢复预览：目标 sha + 受影响文件清单 + 增删汇总。 */
export interface CheckpointPreview {
  targetSha: string;
  files: ShadowNumstatFile[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export type CheckpointService = {
  /**
   * run 开始时的轮次快照（label「轮次开始快照」，kind "turn"）。
   * 目录为空且无提交（无可快照内容）时跳过落行，返回 null。
   */
  beforeTurn(input: {
    canvasId: string;
    sandboxDir: string;
    runId: string;
  }): Promise<CheckpointRow | null>;
  /** run 结束时的轮次快照（label「轮次结束快照」）；无变化不落行。 */
  afterTurn(input: {
    canvasId: string;
    sandboxDir: string;
    runId: string;
  }): Promise<CheckpointRow | null>;
  /** 某画布的全部检查点（createdAt 升序）。 */
  list(input: {
    workspaceId: string;
    canvasId: string;
  }): Promise<CheckpointRow[]>;
  /**
   * 该检查点相对上一检查点的统一 diff；没有上一检查点时与空树比。
   * `path` 给定时只看该文件。`files` 是同区间的逐文件增删（二进制行数为 null）。
   */
  diffFor(input: {
    workspaceId: string;
    checkpointId: string;
    path?: string;
  }): Promise<{
    text: string;
    from: string;
    to: string;
    files: ShadowNumstatFile[];
  }>;
  /** 恢复预览：目标 sha + 工作区相对目标的未提交差异清单（含增删汇总）。 */
  previewRestore(input: {
    workspaceId: string;
    checkpointId: string;
  }): Promise<CheckpointPreview>;
  /**
   * 恢复到目标检查点：先落工作区，再把「回滚」本身记成一个 kind "restore" 的
   * 新检查点（label「回滚恢复点」）。恢复后没有任何可提交差异（目标就是当前
   * 提交且工作区干净）时不新打检查点，返回目标行——它就是恢复后的当前状态。
   */
  restore(input: {
    workspaceId: string;
    checkpointId: string;
  }): Promise<CheckpointRow>;
};

export function createCheckpointService(options: {
  repository: CheckpointRepository;
  canvasRepository: Pick<
    CanvasRepository,
    "findById" | "findWorkspaceIdByCanvas"
  >;
  /** 已建好的影子 git 客户端（生产在外层经 createShadowGitExec 注入 git 二进制）。 */
  git: ShadowGitClient;
  /** 本机 git 来源；unavailable 时一切操作 fail loud（503），不静默降级。 */
  gitSource: GitSource;
  /** 影子仓库根目录（服务端数据目录内），gitDir = <root>/<画布ID>.git。 */
  checkpointRoot: string;
  /** 透传给 resolveSandboxDirFn，与 agent 后端同一套目录解析。 */
  sandboxRoot?: string | undefined;
  canvasWorkDirs?: Record<string, string> | undefined;
  resolveSandboxDirFn: (
    canvasId: string,
    sandboxRoot?: string | undefined,
    workDirOverride?: string | undefined,
  ) => string;
}): CheckpointService {
  const {
    canvasRepository,
    checkpointRoot,
    git,
    gitSource,
    repository,
    resolveSandboxDirFn,
  } = options;

  const requireGitAvailable = (): void => {
    if (gitSource === "unavailable") {
      throw new CodeCheckpointError(
        "git_unavailable",
        "运行环境没有 git，检查点功能不可用（安装 git 或使用随包分发的 git 后重试）。",
        503,
      );
    }
  };

  /** 画布 id → 影子仓库目录（目录名做防御性清洗，防路径穿越）。 */
  const gitDirFor = (canvasId: string): string =>
    join(checkpointRoot, `${sanitizeCanvasIdForPath(canvasId)}.git`);

  const sandboxDirFor = (canvasId: string): string =>
    resolveSandboxDirFn(
      canvasId,
      options.sandboxRoot,
      options.canvasWorkDirs?.[canvasId],
    );

  /** HTTP 路径的画布归属校验：不可见即 404（与 code-git 同一口径）。 */
  const requireCanvas = async (
    workspaceId: string,
    canvasId: string,
  ): Promise<void> => {
    const canvas = await canvasRepository
      .findById(workspaceId, canvasId)
      .catch(() => null);
    if (!canvas) {
      throw new CodeCheckpointError(
        "not_found",
        "画布不存在或不属于当前工作区。",
        404,
      );
    }
  };

  /** 检查点行 → 画布归属复核（行里的 workspaceId 已由仓储谓词保证，这里补画布存在性）。 */
  const rowFor = async (
    workspaceId: string,
    checkpointId: string,
  ): Promise<CheckpointRow> => {
    const row = await repository.getById(workspaceId, checkpointId);
    if (!row) {
      throw new CodeCheckpointError(
        "not_found",
        "检查点不存在或不属于当前工作区。",
        404,
      );
    }
    await requireCanvas(workspaceId, row.canvasId);
    return row;
  };

  const summarizeEntries = (entries: readonly ShadowNumstatFile[]) => ({
    filesChanged: entries.length,
    insertions: entries.reduce((sum, e) => sum + (e.added ?? 0), 0),
    deletions: entries.reduce((sum, e) => sum + (e.deleted ?? 0), 0),
  });

  /**
   * 打一个检查点并落行（调用方已持画布锁）。stats 相对上一行（没有则空树）。
   * commitSnapshot 返回 null（空目录/无变化）时不落行，返回 null。
   */
  const snapshotTo = async (
    input: { canvasId: string; sandboxDir: string; runId: string | null },
    kind: CheckpointKind,
    label: string,
  ): Promise<CheckpointRow | null> => {
    const workspaceId = await canvasRepository.findWorkspaceIdByCanvas(
      input.canvasId,
    );
    if (!workspaceId) {
      throw new CodeCheckpointError(
        "not_found",
        "画布不存在，无法记录检查点。",
        404,
      );
    }
    const scope = {
      gitDir: gitDirFor(input.canvasId),
      workTree: input.sandboxDir,
    };
    await git.ensureRepo({ ...scope, excludes: SHADOW_EXCLUDES });
    const committed = await git.commitSnapshot({ ...scope, message: label });
    if (!committed) {
      return null;
    }
    const previous =
      (await repository.listByCanvas(workspaceId, input.canvasId)).at(-1) ??
      null;
    const stats = summarizeEntries(
      await git.numstat({
        ...scope,
        from: previous?.shadowCommit ?? EMPTY_TREE_SHA,
        to: committed.sha,
      }),
    );
    const row: CheckpointRow = {
      id: randomUUID(),
      workspaceId,
      canvasId: input.canvasId,
      runId: input.runId,
      kind,
      label,
      shadowCommit: committed.sha,
      ...stats,
      createdAt: new Date().toISOString(),
    };
    await repository.insert(row);
    return row;
  };

  /** 每画布互斥：影子仓库的 index 是共享状态，快照/预览/恢复必须串行。 */
  const locks = new Map<string, Promise<unknown>>();
  const withLock = async <T>(
    canvasId: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    const previous = locks.get(canvasId) ?? Promise.resolve();
    // 前一个任务无论成败都不毒化链条
    const current = previous.then(task, task);
    locks.set(canvasId, current);
    try {
      return await current;
    } finally {
      if (locks.get(canvasId) === current) {
        locks.delete(canvasId);
      }
    }
  };

  /** 可用性门 + 错误折叠：git 的原话折成带状态码的 CodeCheckpointError。 */
  const guarded = async <T>(task: () => Promise<T>): Promise<T> => {
    requireGitAvailable();
    try {
      return await task();
    } catch (error) {
      if (error instanceof CodeCheckpointError) {
        throw error;
      }
      throw new CodeCheckpointError(
        "checkpoint_failed",
        error instanceof Error ? error.message : String(error),
        409,
      );
    }
  };

  const runExclusive = <T>(
    canvasId: string,
    task: () => Promise<T>,
  ): Promise<T> => withLock(canvasId, () => guarded(task));

  return {
    beforeTurn: (input) =>
      runExclusive(input.canvasId, () =>
        snapshotTo(input, "turn", "轮次开始快照"),
      ),

    afterTurn: (input) =>
      runExclusive(input.canvasId, () =>
        snapshotTo(input, "turn", "轮次结束快照"),
      ),

    list: (input) =>
      guarded(async () => {
        await requireCanvas(input.workspaceId, input.canvasId);
        return repository.listByCanvas(input.workspaceId, input.canvasId);
      }),

    diffFor: (input) =>
      guarded(async () => {
        const row = await rowFor(input.workspaceId, input.checkpointId);
        const scope = {
          gitDir: gitDirFor(row.canvasId),
          workTree: sandboxDirFor(row.canvasId),
        };
        const previous = await repository.getPrevious(
          input.workspaceId,
          row.canvasId,
          row.createdAt,
        );
        const from = previous?.shadowCommit ?? EMPTY_TREE_SHA;
        const text = await git.diffText({
          ...scope,
          from,
          to: row.shadowCommit,
          ...(input.path ? { path: input.path } : {}),
        });
        const files = await git.numstat({
          ...scope,
          from,
          to: row.shadowCommit,
        });
        return { text, from, to: row.shadowCommit, files };
      }),

    previewRestore: (input) =>
      guarded(async () => {
        const row = await rowFor(input.workspaceId, input.checkpointId);
        const gitDir = gitDirFor(row.canvasId);
        const workTree = sandboxDirFor(row.canvasId);
        return withLock(row.canvasId, async () => {
          const files = await git.changedAgainst({
            gitDir,
            workTree,
            sha: row.shadowCommit,
          });
          return {
            targetSha: row.shadowCommit,
            files,
            ...summarizeEntries(files),
          };
        });
      }),

    restore: (input) =>
      guarded(async () => {
        const row = await rowFor(input.workspaceId, input.checkpointId);
        const gitDir = gitDirFor(row.canvasId);
        const workTree = sandboxDirFor(row.canvasId);
        return withLock(row.canvasId, async () => {
          await git.restoreTo({ gitDir, workTree, sha: row.shadowCommit });
          // 无新检查点（目标即当前且工作区干净）时返回目标行：它就是恢复后的当前状态
          return (
            (await snapshotTo(
              { canvasId: row.canvasId, sandboxDir: workTree, runId: null },
              "restore",
              "回滚恢复点",
            )) ?? row
          );
        });
      }),
  };
}
