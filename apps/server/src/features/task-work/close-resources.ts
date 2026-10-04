import type { AgentRunService } from "../../agent/runtime.js";
import type { CapabilityRegistry } from "../../kernel/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { AuthenticatedUser } from "../auth/types.js";
import { forgetTaskFileState, revokeTaskFileOperations } from "../execution/scoped-filesystem.js";
import type { ProcessSandbox } from "../process-sandbox/types.js";
import type { TaskWorkManager } from "./types.js";

/** 延迟解析跨域引用以避免装配环；关闭失败保留 revoking/failed，不报告资源已退出。 */
export function createTaskResourceCloser(deps: {
  viewer: ViewerService;
  resources: () => { runs: AgentRunService; work: TaskWorkManager; sandbox: ProcessSandbox; capabilities: CapabilityRegistry };
}) {
  return async (actor: AuthenticatedUser, taskId: string, reason: string) => {
    const workspace = await deps.viewer.resolveWorkspace(actor);
    const resources = deps.resources();
    const stopped = await Promise.allSettled([
      resources.runs.cancelTaskRuns(taskId),
      resources.work.closeTask(workspace.id, taskId, reason),
      revokeTaskFileOperations(workspace.id, taskId),
    ]);
    const failure = stopped.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    for (const registration of resources.capabilities.list<{ close: (workspaceId: string, taskId: string) => void | Promise<void> }>("task-before-process-close")) await registration.value.close(workspace.id, taskId);
    // executor 先结算输出，之后才关闭 helper；关闭 IPC 不能被当作进程退出证据。
    await resources.sandbox.closeTask(taskId, reason);
    for (const registration of resources.capabilities.list<{ close: (workspaceId: string, taskId: string) => void | Promise<void> }>("task-close")) await registration.value.close(workspace.id, taskId);
    forgetTaskFileState(workspace.id, taskId);
  };
}
