import { createHash } from "node:crypto";
import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import type { ExecutionScopes } from "../execution/scope-service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { PersistenceService } from "../persistence/types.js";
import { createTaskProjectMoveRepository } from "./task-project-move-repository.js";
import {
  moveConflict,
  moveNotFound,
  type TaskProjectMoveEvent,
  type TaskProjectMoveInput,
  taskProjectMoveInputSchema,
} from "./task-project-move-types.js";

export interface TaskProjectMoveService {
  moveTask(
    actor: LocalActor,
    input: TaskProjectMoveInput,
    signal: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}

export function createTaskProjectMoveService(deps: {
  persistence: PersistenceService;
  localInstance: Pick<LocalInstanceService, "resolve">;
  executionScopes: Pick<ExecutionScopes, "openTask">;
  closeTask(actor: LocalActor, taskId: string): Promise<void>;
  afterMove(actor: LocalActor, event: TaskProjectMoveEvent): Promise<void>;
}): TaskProjectMoveService {
  const repository = createTaskProjectMoveRepository(deps.persistence);
  let closing = false;
  const pending = new Map<
    string,
    {
      fingerprint: string;
      signal: AbortSignal;
      admission: { prepared: boolean };
      completed: Promise<void>;
    }
  >();

  async function prepareMove(
    actor: LocalActor,
    instanceId: string,
    input: TaskProjectMoveInput,
    fingerprint: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const previous = await repository.replay(
      instanceId,
      input,
      fingerprint,
      signal,
    );
    if (previous) return previous;
    let opened: Awaited<ReturnType<ExecutionScopes["openTask"]>>;
    try {
      opened = await deps.executionScopes.openTask(actor, input.task.taskId);
    } catch (error) {
      signal.throwIfAborted();
      // 其它进程可能在首次查回执之后认领了同一次移动。
      const raced = await repository.replay(
        instanceId,
        input,
        fingerprint,
        signal,
      );
      if (raced) return raced;
      throw error;
    }
    signal.throwIfAborted();
    return repository.prepare(
      instanceId,
      input,
      fingerprint,
      opened.describe(),
      signal,
    );
  }

  async function move(
    actor: LocalActor,
    instanceId: string,
    input: TaskProjectMoveInput,
    fingerprint: string,
    signal: AbortSignal,
    admission: { prepared: boolean },
  ) {
    const prepared = await prepareMove(
      actor,
      instanceId,
      input,
      fingerprint,
      signal,
    );
    admission.prepared = true;
    // 准备事务接纳后必须完成原资源关闭及归属更新，连接关闭等待这段工作退出。
    if (!prepared.committed) {
      try {
        await deps.closeTask(actor, input.task.taskId);
        await repository.commit(
          instanceId,
          input,
          fingerprint,
          prepared.generation,
        );
      } catch (error) {
        await repository.fail(
          instanceId,
          input.task.taskId,
          prepared.generation,
        );
        throw error;
      }
    }
    await deps.afterMove(actor, {
      instanceId,
      taskId: input.task.taskId,
      sourceProjectId: input.sourceProjectId,
      targetProjectId: input.projectId,
      workspacePath: prepared.workspacePath,
      sessionIds: prepared.sessionIds,
    });
  }

  return {
    async moveTask(actor, value, signal) {
      signal.throwIfAborted();
      if (closing) throw moveConflict("项目服务正在关闭，请重新连接后再试。");
      const input = taskProjectMoveInputSchema.parse(value);
      if (input.hostId !== undefined && input.hostId !== "local")
        throw moveConflict("project.cross-host-move");
      const identity = canonicalLocalWorkspaceIdentity(
        input.sourceProjectId,
        input.task.workspacePath,
      );
      if (
        input.task.workspaceIdentity !== undefined &&
        input.task.workspaceIdentity !== identity
      )
        throw moveNotFound();
      const { instanceId } = await deps.localInstance.resolve(actor);
      signal.throwIfAborted();
      if (closing) throw moveConflict("项目服务正在关闭，请重新连接后再试。");
      const key = JSON.stringify([
        instanceId,
        input.task.taskId,
        input.sourceProjectId,
        input.projectId,
        input.observedRevision,
      ]);
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            input.task.workspacePath,
            identity,
            input.addMissingRoot === true,
          ]),
        )
        .digest("hex");
      let previous = pending.get(key);
      while (previous) {
        if (previous.fingerprint !== fingerprint)
          throw moveConflict("同一次移动不能提交不同参数，请重新加载任务。");
        try {
          await previous.completed;
          return;
        } catch (error) {
          signal.throwIfAborted();
          if (
            previous.admission.prepared ||
            !previous.signal.aborted ||
            error !== previous.signal.reason
          )
            throw error;
          // 另一连接在接纳前取消时，在线调用仍使用自己的观察值与原业务键。
        }
        if (pending.get(key) === previous) pending.delete(key);
        previous = pending.get(key);
      }
      signal.throwIfAborted();
      if (closing) throw moveConflict("项目服务正在关闭，请重新连接后再试。");
      const admission = { prepared: false };
      const completed = move(
        actor,
        instanceId,
        input,
        fingerprint,
        signal,
        admission,
      );
      pending.set(key, { fingerprint, signal, admission, completed });
      try {
        await completed;
      } finally {
        if (pending.get(key)?.completed === completed) pending.delete(key);
      }
    },
    async close() {
      closing = true;
      const results = await Promise.allSettled(
        [...pending.values()].map((operation) => operation.completed),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          "项目移动未全部完成，请重新连接核对任务。",
        );
    },
  };
}
