import type { AgentRunService } from "../../agent/runtime.js";
import type { CapabilityRegistry } from "../../kernel/types.js";
import {
  forgetTaskFileState,
  revokeTaskFileOperations,
} from "../execution/scoped-filesystem.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ProcessSandbox } from "../process-sandbox/types.js";
import type { TaskWorkManager } from "./types.js";

/** 延迟解析跨域引用以避免装配环；关闭失败保留 revoking/failed，不报告资源已退出。 */
export function createTaskResourceCloser(deps: {
  localInstance: LocalInstanceService;
  resources: () => {
    runs: AgentRunService;
    work: TaskWorkManager;
    sandbox: ProcessSandbox;
    capabilities: CapabilityRegistry;
  };
}) {
  return async (actor: LocalActor, taskId: string, reason: string) => {
    const workspace = await deps.localInstance.resolve(actor);
    const resources = deps.resources();
    const stopped = await Promise.allSettled([
      resources.runs.cancelTaskRuns(taskId),
      resources.work.closeTask(workspace.instanceId, taskId, reason),
      revokeTaskFileOperations(workspace.instanceId, taskId),
    ]);
    const failure = stopped.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    for (const registration of resources.capabilities.list<{
      close: (instanceId: string, taskId: string) => void | Promise<void>;
    }>("task-before-process-close"))
      await registration.value.close(workspace.instanceId, taskId);
    // executor 先结算输出，之后才关闭 helper；关闭 IPC 不能被当作进程退出证据。
    await resources.sandbox.closeTask(taskId, reason);
    for (const registration of resources.capabilities.list<{
      close: (instanceId: string, taskId: string) => void | Promise<void>;
    }>("task-close"))
      await registration.value.close(workspace.instanceId, taskId);
    forgetTaskFileState(workspace.instanceId, taskId);
  };
}
