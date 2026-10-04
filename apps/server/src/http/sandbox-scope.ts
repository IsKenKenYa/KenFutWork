import type { WorkDirectoryTarget } from "@kenfutwork/shared";
import { resolveSandboxDir } from "../agent/sandbox-dir.js";
import type { AuthenticatedUser } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CanvasRepository } from "../features/canvas/repository.js";
import {
  ExecutionScopeError,
  type ExecutionScopeHandle,
  type ExecutionScopes,
} from "../features/execution/scope-service.js";
import type { ProjectService } from "../features/projects/project-service.js";

/**
 * `canvasId → 已校验归属的沙箱目录`：HTTP 路由里「从工作目录导入/安装」类端点的公共前置。
 *
 * 抽出来是因为技能包导入与插件 bundle 安装要做**完全相同**的判定：
 * 工作区解析 → 画布归属 → `resolveSandboxDir`（与 agent/git 同一处解析，
 * 工作目录映射优先，否则 `<沙箱根>/<画布UUID>`）。两处各写一份必然漂移。
 *
 * 不可见一律返回 null（由调用方转 404，不区分「不存在」与「不属于你」）。
 */
export async function resolveSandboxForCanvas(
  deps: {
    viewerService: ViewerService;
    canvasRepository: CanvasRepository;
    projects: Pick<ProjectService, "getProject">;
    sandboxRoot?: string | undefined;
    canvasWorkDirs?: Record<string, string> | undefined;
    /** 项目绑定的本机工作目录（`projects.work_dir`）；界面绑定优先于环境变量映射。 */
    projectWorkDirLoader?:
      | ((canvasId: string) => Promise<string | null>)
      | undefined;
  },
  user: AuthenticatedUser,
  canvasId: string,
): Promise<string | null> {
  const workspace = await deps.viewerService
    .resolveWorkspace(user)
    .catch(() => null);
  if (!workspace) return null;
  const canvas = await deps.canvasRepository
    .findById(workspace.id, canvasId)
    .catch(() => null);
  if (!canvas) return null;
  const project = await deps.projects.getProject(user, canvas.project_id);
  if (project.kind === "code")
    throw new ExecutionScopeError(
      "invalid_scope",
      "Code 工作目录必须显式指定 Task，不能用 Canvas 身份。",
      400,
    );
  const boundWorkDir = deps.projectWorkDirLoader
    ? await deps.projectWorkDirLoader(canvasId).catch(() => null)
    : null;
  return resolveSandboxDir(
    canvasId,
    deps.sandboxRoot,
    boundWorkDir ?? deps.canvasWorkDirs?.[canvasId],
  );
}

export async function resolveWorkDirectoryTarget(
  deps: Parameters<typeof resolveSandboxForCanvas>[0] & {
    executionScopes: Pick<ExecutionScopes, "openTask">;
  },
  actor: AuthenticatedUser,
  target: WorkDirectoryTarget,
): Promise<{ rootDirectory: string; scope: ExecutionScopeHandle | null }> {
  if ("taskId" in target) {
    const scope = await deps.executionScopes.openTask(actor, target.taskId);
    return { rootDirectory: await scope.resolvePath(".", "read"), scope };
  }
  const rootDirectory = await resolveSandboxForCanvas(
    deps,
    actor,
    target.canvasId,
  );
  if (!rootDirectory)
    throw new ExecutionScopeError(
      "task_not_found",
      "画布不存在或不属于当前工作区。",
      404,
    );
  return { rootDirectory, scope: null };
}
