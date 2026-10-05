import { randomUUID } from "node:crypto";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { createTaskWorkManager } from "./service.js";
import type {
  TaskWorkCloseFence,
  TaskWorkContext,
  TaskWorkHostLease,
  TaskWorkOutcome,
  TaskWorkRecord,
  TaskWorkStore,
} from "./types.js";

/** 内存 adapter 与 Postgres 消费相同的公开工作生命周期 seam。 */
export function createMemoryTaskWorkStore(
  initialTasks: readonly TaskWorkContext[] = [],
): TaskWorkStore & {
  invalidate(): void;
  setTask(context: TaskWorkContext, state?: TaskWorkCloseFence["state"]): void;
  loseHost(executionHostId: string): void;
} {
  const records = new Map<string, TaskWorkRecord>();
  let current = true;
  const taskKey = (instanceId: string, taskId: string) =>
    JSON.stringify([instanceId, taskId]);
  const tasks = new Map<string, TaskWorkCloseFence & { projectId: string }>();
  const hosts = new Map<
    string,
    { ownerId: string; lease: TaskWorkHostLease; controller: AbortController }
  >();
  const setTask = (
    context: TaskWorkContext,
    state: TaskWorkCloseFence["state"] = "ready",
  ) => {
    tasks.set(taskKey(context.scope.instanceId, context.scope.taskId), {
      projectId: context.scope.projectId,
      scopeGeneration: context.scope.generation,
      branchGeneration: context.branchGeneration,
      state,
    });
  };
  for (const context of initialTasks) setTask(context);
  const owned = (instanceId: string, taskId: string, record: TaskWorkRecord) =>
    record.scope.instanceId === instanceId && record.scope.taskId === taskId;
  return {
    invalidate() {
      current = false;
    },
    setTask,
    loseHost(executionHostId) {
      const previous = hosts.get(executionHostId);
      hosts.delete(executionHostId);
      previous?.controller.abort(new Error("测试宿主会话丢失。"));
    },
    async acquireHost(executionHostId, ownerId) {
      if (hosts.has(executionHostId)) return null;
      const controller = new AbortController();
      const lease: TaskWorkHostLease = {
        signal: controller.signal,
        async release() {
          if (hosts.get(executionHostId)?.lease === lease)
            hosts.delete(executionHostId);
          controller.abort(new Error("测试宿主会话释放。"));
        },
      };
      hosts.set(executionHostId, { ownerId, lease, controller });
      return lease;
    },
    async closeFence(instanceId, taskId) {
      return structuredClone(tasks.get(taskKey(instanceId, taskId)) ?? null);
    },
    async isCurrent(context, purpose) {
      const task = tasks.get(
        taskKey(context.scope.instanceId, context.scope.taskId),
      );
      return (
        current &&
        task?.projectId === context.scope.projectId &&
        task.branchGeneration === context.branchGeneration &&
        task.state === "ready" &&
        (purpose === "notification" ||
          task.scopeGeneration === context.scope.generation)
      );
    },
    async create(record) {
      const existing = [...records.values()].find(
        (candidate) =>
          owned(record.scope.instanceId, record.scope.taskId, candidate) &&
          candidate.originRunId === record.originRunId &&
          candidate.toolCallId === record.toolCallId &&
          candidate.branchGeneration === record.branchGeneration,
      );
      if (existing)
        return { record: structuredClone(existing), created: false };
      records.set(record.id, structuredClone(record));
      return { record: structuredClone(record), created: true };
    },
    async find(instanceId, taskId, workId) {
      const record = records.get(workId);
      return record && owned(instanceId, taskId, record)
        ? structuredClone(record)
        : null;
    },
    async list(instanceId, taskId) {
      return [...records.values()]
        .filter((record) => owned(instanceId, taskId, record))
        .map((record) => structuredClone(record));
    },
    async settle(
      instanceId: string,
      taskId: string,
      workId: string,
      outcome: TaskWorkOutcome,
      at: string,
    ) {
      const record = records.get(workId);
      if (
        !record ||
        !owned(instanceId, taskId, record) ||
        record.status !== "running"
      )
        return null;
      Object.assign(record, outcome, { endedAt: at });
      return structuredClone(record);
    },
    async consume(context: TaskWorkContext) {
      if (!current) return [];
      const pending = [...records.values()].filter(
        (record) =>
          owned(context.scope.instanceId, context.scope.taskId, record) &&
          record.detached &&
          record.branchGeneration === context.branchGeneration &&
          record.status !== "running" &&
          !record.consumed,
      );
      pending.forEach((record) => {
        record.consumed = true;
      });
      return structuredClone(pending);
    },
    async interruptHost(executionHostId, ownerId, at) {
      const host = hosts.get(executionHostId);
      if (!host || host.ownerId !== ownerId || host.lease.signal.aborted)
        throw new Error("未持有测试宿主会话。");
      const changed: TaskWorkRecord[] = [];
      for (const record of records.values()) {
        if (
          record.executionHostId === executionHostId &&
          record.ownerId !== ownerId &&
          (record.status === "running" || !record.consumed)
        ) {
          if (record.status === "running")
            Object.assign(record, {
              status: "interrupted",
              endedAt: at,
              summary: "执行宿主重启，后台工作已中断；保留输出，不自动重放。",
            });
          record.consumed = true;
          changed.push(structuredClone(record));
        }
      }
      return changed;
    },
    async updateOutput(instanceId, taskId, workId, ownerId, outputRef, stats) {
      const record = records.get(workId);
      if (
        record &&
        owned(instanceId, taskId, record) &&
        record.ownerId === ownerId &&
        record.status === "running"
      )
        Object.assign(record, { outputRef, outputStats: stats });
    },
  };
}

/** HTTP/app测试的公共内存Provider；不进入生产profile，不伪造Postgres session。 */
export function createMemoryTaskWorkManager() {
  return createTaskWorkManager({
    store: createMemoryTaskWorkStore([]),
    executionHostId: randomUUID(),
    resolveMaxConcurrent: async () =>
      AGENT_GOVERNANCE_DEFAULTS.subagentMaxConcurrency,
  });
}
