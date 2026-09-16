import { resolveSandboxDir } from "../agent/sandbox-dir.js";
import type { AuthenticatedUser } from "../features/auth/types.js";
import type { CanvasRepository } from "../features/canvas/repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";

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
    sandboxRoot?: string | undefined;
    canvasWorkDirs?: Record<string, string> | undefined;
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
  return resolveSandboxDir(
    canvasId,
    deps.sandboxRoot,
    deps.canvasWorkDirs?.[canvasId],
  );
}
