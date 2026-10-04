import { randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  type CodeExecutionScope,
  codeExecutionScopeSchema,
} from "@kenfutwork/shared";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { FileLimits } from "../code-tools/file-types.js";
import type {
  ScopeRepository,
  StoredExecutionScope,
  TaskScopePatch,
} from "./scope-repository.js";
import {
  createScopedBackend,
  type ScopedBackend,
} from "./scoped-filesystem.js";

export type ExecutionRole = "main" | "explore" | "review" | "worker";
export interface ExecutionScopeHandle {
  describe(): CodeExecutionScope;
  readonly role: ExecutionRole;
  readonly agentId: string;
  derive(role: ExecutionRole, agentId?: string): ExecutionScopeHandle;
  resolvePath(path: string, operation: "read" | "write"): Promise<string>;
  readonly backend: ScopedBackend;
}
export type ScopeRevocation = {
  previous: CodeExecutionScope;
  next: CodeExecutionScope;
};
export interface ExecutionScopes {
  openTask(
    actor: AuthenticatedUser,
    taskId: string,
  ): Promise<ExecutionScopeHandle>;
  /** 仅系统恢复 consumer；普通 HTTP/Run 不得调用此权限入口。 */
  openRestoringTask(
    actor: AuthenticatedUser,
    taskId: string,
    expectedGeneration: number,
  ): Promise<ExecutionScopeHandle>;
  updateTask(
    actor: AuthenticatedUser,
    taskId: string,
    patch: TaskScopePatch,
  ): Promise<CodeExecutionScope>;
  onRevoke(listener: (event: ScopeRevocation) => Promise<void>): () => void;
  onUpdated(listener: (event: ScopeRevocation) => Promise<void>): () => void;
}

export class ExecutionScopeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 403,
  ) {
    super(message);
    this.name = "ExecutionScopeError";
  }
}

function inside(root: string, path: string): boolean {
  const tail = relative(root, path);
  return (
    tail === "" ||
    (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`))
  );
}

function accessAt(
  scope: Pick<
    CodeExecutionScope,
    "rootDirectory" | "additionalDirectories" | "sandboxMode"
  >,
  path: string,
): "read-only" | "read-write" | null {
  const roots = [
    { path: scope.rootDirectory, access: "read-write" as const },
    ...scope.additionalDirectories,
  ]
    .filter((root) => inside(root.path, path))
    .sort(
      (a, b) =>
        b.path.length - a.path.length || (a.access === "read-only" ? -1 : 1),
    );
  if (!roots[0]) return null;
  return scope.sandboxMode === "read-only" ? "read-only" : roots[0].access;
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new ExecutionScopeError(
      "invalid_scope",
      "授权目录必须是绝对路径。",
      400,
    );
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory())
    throw new ExecutionScopeError(
      "invalid_scope",
      `授权目录不是文件夹：${path}`,
      400,
    );
  return canonical;
}

async function canonicalScope(
  input: CodeExecutionScope,
): Promise<CodeExecutionScope> {
  const scope = codeExecutionScopeSchema.parse(input);
  return {
    ...scope,
    rootDirectory: await canonicalDirectory(scope.rootDirectory),
    additionalDirectories: await Promise.all(
      scope.additionalDirectories.map(async (directory) => ({
        ...directory,
        path: await canonicalDirectory(directory.path),
      })),
    ),
  };
}

/** 新文件沿最近存在的父目录解析；失效 symlink 不能伪装成新文件。 */
async function canonicalTarget(path: string): Promise<string> {
  let cursor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...suffix);
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
      const existing = await lstat(cursor).catch((failure: unknown) => {
        if (
          failure &&
          typeof failure === "object" &&
          "code" in failure &&
          failure.code === "ENOENT"
        )
          return null;
        throw failure;
      });
      if (existing)
        throw new ExecutionScopeError(
          "invalid_path",
          "路径的符号链接目标不存在，不能作为新文件写入。",
        );
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function canonicalStoredScope(
  input: CodeExecutionScope,
): Promise<CodeExecutionScope> {
  const scope = codeExecutionScopeSchema.parse(input);
  const rootDirectory = await canonicalDirectory(scope.rootDirectory);
  if (rootDirectory !== scope.rootDirectory)
    throw new ExecutionScopeError(
      "scope_changed",
      "Task 固定主目录的真实路径已改变，请重新处理目录授权。",
      409,
    );
  for (const directory of scope.additionalDirectories) {
    const actual = await canonicalTarget(directory.path);
    if (actual !== directory.path)
      throw new ExecutionScopeError(
        "scope_changed",
        "附加目录的真实路径已改变，请显式更新目录授权。",
        409,
      );
    // 缺失引用可移除；不存在的只读根仍保留其路径限制，不借父目录扩权。
    const metadata = await stat(actual).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    });
    if (metadata && !metadata.isDirectory())
      throw new ExecutionScopeError(
        "invalid_scope",
        "附加目录已不再是文件夹，请更新目录授权。",
        409,
      );
  }
  return scope;
}

/** 人工项目草稿预览的只读缝；没有 Task/执行代际，也不会签发模型执行权限。 */
export async function resolveReadOnlyProjectPath(
  grants: Pick<CodeExecutionScope, "rootDirectory" | "additionalDirectories">,
  path: string,
): Promise<string> {
  const rootDirectory = await canonicalDirectory(grants.rootDirectory);
  const additionalDirectories = await Promise.all(
    grants.additionalDirectories.map(async (entry) => ({
      path: await canonicalDirectory(entry.path),
      access: "read-only" as const,
    })),
  );
  const target = await canonicalTarget(resolve(rootDirectory, path));
  if (
    !accessAt(
      { rootDirectory, additionalDirectories, sandboxMode: "read-only" },
      target,
    )
  )
    throw new ExecutionScopeError(
      "path_denied",
      "文件不属于已选项目的只读预览目录。",
    );
  return target;
}

function intersect(
  current: CodeExecutionScope,
  ceiling: CodeExecutionScope,
  readOnly: boolean,
): CodeExecutionScope {
  if (current.rootDirectory !== ceiling.rootDirectory)
    throw new ExecutionScopeError(
      "scope_changed",
      "Task 主目录发生变化，请重新打开任务。",
      409,
    );
  const paths = new Set(
    [...current.additionalDirectories, ...ceiling.additionalDirectories].map(
      (root) => root.path,
    ),
  );
  const additionalDirectories = [...paths].flatMap((path) => {
    const live = accessAt(current, path);
    const limit = accessAt(ceiling, path);
    return live && limit
      ? [
          {
            path,
            access:
              readOnly || live === "read-only" || limit === "read-only"
                ? ("read-only" as const)
                : ("read-write" as const),
          },
        ]
      : [];
  });
  return {
    ...current,
    additionalDirectories,
    sandboxMode:
      readOnly ||
      current.sandboxMode === "read-only" ||
      ceiling.sandboxMode === "read-only"
        ? "read-only"
        : current.sandboxMode === "danger-full-access" &&
            ceiling.sandboxMode === "danger-full-access"
          ? "danger-full-access"
          : "workspace-write",
  };
}

class ScopeHandle implements ExecutionScopeHandle {
  readonly backend: ScopedBackend;
  private current: CodeExecutionScope;
  constructor(
    private readonly load: () => Promise<CodeExecutionScope>,
    private readonly ceiling: CodeExecutionScope,
    readonly role: ExecutionRole,
    readonly agentId: string,
    private readonly readOnly: boolean,
    private readonly limits?: FileLimits,
  ) {
    this.current = intersect(ceiling, ceiling, readOnly);
    this.backend = createScopedBackend(this, limits ? { limits } : {});
  }
  describe(): CodeExecutionScope {
    return structuredClone(this.current);
  }
  derive(role: ExecutionRole, agentId = randomUUID()): ExecutionScopeHandle {
    return new ScopeHandle(
      this.load,
      this.current,
      role,
      agentId,
      this.readOnly || role === "explore" || role === "review",
      this.limits,
    );
  }
  async resolvePath(
    path: string,
    operation: "read" | "write",
  ): Promise<string> {
    if (!path.trim() || path.includes("\0"))
      throw new ExecutionScopeError(
        "invalid_path",
        "路径不能为空或包含空字符。",
        400,
      );
    this.current = intersect(await this.load(), this.ceiling, this.readOnly);
    const target = await canonicalTarget(
      resolve(this.current.rootDirectory, path),
    );
    // realpath 等待期间发生撤销时，本操作也必须拒绝。
    this.current = intersect(await this.load(), this.ceiling, this.readOnly);
    const access = accessAt(this.current, target);
    if (!access)
      throw new ExecutionScopeError(
        "path_denied",
        "路径不属于 Task 的授权目录。",
      );
    if (operation === "write" && access !== "read-write")
      throw new ExecutionScopeError(
        "read_only",
        "当前角色或目录为只读，不能修改文件。",
      );
    return target;
  }
}

type ScopeOptions = {
  repository: ScopeRepository;
  viewerService: Pick<ViewerService, "resolveWorkspace">;
  resolveFileLimits?: (
    actor: AuthenticatedUser,
    scope: CodeExecutionScope,
  ) => Promise<FileLimits>;
};

async function requireStored(
  repository: ScopeRepository,
  workspaceId: string,
  taskId: string,
): Promise<StoredExecutionScope> {
  const stored = await repository.load(workspaceId, taskId);
  if (
    !stored ||
    stored.scope.workspaceId !== workspaceId ||
    stored.scope.taskId !== taskId
  ) {
    throw new ExecutionScopeError(
      "task_not_found",
      "Code Task 不属于当前工作区或已经删除。",
      404,
    );
  }
  return stored;
}

export function createExecutionScopes(options: ScopeOptions): ExecutionScopes {
  const revokers = new Set<(event: ScopeRevocation) => Promise<void>>();
  const updatedListeners = new Set<(event: ScopeRevocation) => Promise<void>>();
  const open = async (
    actor: AuthenticatedUser,
    taskId: string,
    restoringGeneration?: number,
  ): Promise<ExecutionScopeHandle> => {
    const workspace = await options.viewerService.resolveWorkspace(actor);
    const opened = await requireStored(
      options.repository,
      workspace.id,
      taskId,
    );
    const branchGeneration = opened.branchGeneration;
    if (!Number.isSafeInteger(branchGeneration) || branchGeneration < 1)
      throw new ExecutionScopeError(
        "invalid_scope",
        "Task 分支代际无效，禁止执行。",
        409,
      );
    if (
      restoringGeneration !== undefined &&
      (!Number.isSafeInteger(restoringGeneration) ||
        restoringGeneration < 1 ||
        opened.scope.generation !== restoringGeneration ||
        opened.state !== "revoking")
    )
      throw new ExecutionScopeError(
        "scope_unavailable",
        "Task 恢复代际不匹配或不处于恢复屏障内。",
        409,
      );
    const load = async () => {
      const stored = await requireStored(
        options.repository,
        workspace.id,
        taskId,
      );
      if (stored.branchGeneration !== branchGeneration)
        throw new ExecutionScopeError(
          "branch_changed",
          "Task 分支已经改变，旧执行句柄已失效。",
          409,
        );
      const restoring = restoringGeneration !== undefined;
      if (
        restoring
          ? stored.state !== "revoking" ||
            stored.scope.generation !== restoringGeneration
          : stored.state !== "ready"
      )
        throw new ExecutionScopeError(
          "scope_unavailable",
          `Task 执行授权${stored.state === "revoking" ? "正在撤销" : stored.state === "failed" ? "撤销失败" : "恢复已结束"}，当前禁止新操作。`,
          409,
        );
      return canonicalStoredScope(stored.scope);
    };
    const scope = await load();
    const limits = await options.resolveFileLimits?.(actor, scope);
    return new ScopeHandle(
      load,
      scope,
      "main",
      restoringGeneration === undefined
        ? "main"
        : `checkpoint-restore:${restoringGeneration}`,
      false,
      limits,
    );
  };
  return {
    openTask: (actor, taskId) => open(actor, taskId),
    openRestoringTask: (actor, taskId, expectedGeneration) =>
      open(actor, taskId, expectedGeneration),
    async updateTask(actor, taskId, patch) {
      const workspace = await options.viewerService.resolveWorkspace(actor);
      const stored = await requireStored(
        options.repository,
        workspace.id,
        taskId,
      );
      if (stored.state === "revoking")
        throw new ExecutionScopeError(
          "scope_revoking",
          "Task 正在撤销，请等待真实进程退出。",
          409,
        );
      const previous = codeExecutionScopeSchema.parse(stored.scope);
      if (
        (await canonicalDirectory(previous.rootDirectory)) !==
        previous.rootDirectory
      )
        throw new ExecutionScopeError(
          "scope_changed",
          "Task 固定主目录的真实路径已改变，不能隐式重绑。",
          409,
        );
      const candidate = {
        ...previous,
        additionalDirectories:
          patch.additionalDirectories ?? previous.additionalDirectories,
        sandboxMode: patch.sandboxMode ?? previous.sandboxMode,
      };
      const next =
        patch.additionalDirectories !== undefined
          ? await canonicalScope(candidate)
          : await canonicalStoredScope(candidate);
      if (
        stored.state === "ready" &&
        JSON.stringify(previous) === JSON.stringify(next)
      )
        return previous;
      if (
        !options.repository.beginUpdate ||
        !options.repository.finishUpdate ||
        revokers.size === 0
      ) {
        throw new ExecutionScopeError(
          "revoker_unavailable",
          "执行资源撤销器不可用，不能修改 Task 授权。",
          503,
        );
      }
      const normalizedPatch: TaskScopePatch = {
        ...(patch.additionalDirectories !== undefined
          ? { additionalDirectories: next.additionalDirectories }
          : {}),
        ...(patch.sandboxMode !== undefined
          ? { sandboxMode: next.sandboxMode }
          : {}),
      };
      const pending = await options.repository.beginUpdate(
        previous,
        normalizedPatch,
      );
      if (!pending)
        throw new ExecutionScopeError(
          "scope_conflict",
          "Task 授权已被另一请求修改，请重新获取。",
          409,
        );
      let ready: CodeExecutionScope;
      try {
        const settled = await Promise.allSettled(
          [...revokers].map((revoke) =>
            revoke({ previous, next: pending.scope }),
          ),
        );
        const failed = settled.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        ready = await canonicalStoredScope(pending.scope);
        if (!(await options.repository.finishUpdate(pending.scope, "ready")))
          throw new ExecutionScopeError(
            "scope_conflict",
            "撤销完成后 Task 已删除或授权代际改变。",
            409,
          );
      } catch (error) {
        await options.repository.finishUpdate(pending.scope, "failed");
        throw error;
      }
      const delivered = await Promise.allSettled(
        [...updatedListeners].map((listener) =>
          listener({ previous, next: ready }),
        ),
      );
      for (const result of delivered) {
        if (result.status === "rejected")
          console.warn(
            "[execution-scopes] 授权已更新，后续通知失败",
            result.reason,
          );
      }
      return ready;
    },
    onRevoke(listener) {
      revokers.add(listener);
      return () => {
        revokers.delete(listener);
      };
    },
    onUpdated(listener) {
      updatedListeners.add(listener);
      return () => {
        updatedListeners.delete(listener);
      };
    },
  };
}
