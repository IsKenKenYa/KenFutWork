import { randomUUID } from "node:crypto";
import { parameterFingerprint as fingerprintParameters } from "../execution/parameter-fingerprint.js";
import type {
  TaskWorkContext,
  TaskWorkExecutor,
  TaskWorkHostLease,
  TaskWorkHostLoss,
  TaskWorkManager,
  TaskWorkOutcome,
  TaskWorkRecord,
  TaskWorkStore,
} from "./types.js";

export class TaskWorkError extends Error {
  constructor(
    readonly code:
      | "task_closed"
      | "foreground_busy"
      | "concurrency_limit"
      | "work_not_found"
      | "stop_unconfirmed"
      | "dispatch_conflict"
      | "execution_host_busy"
      | "execution_host_lost",
    message: string,
  ) {
    super(message);
    this.name = "TaskWorkError";
  }
}

interface LiveWork {
  context: TaskWorkContext;
  executor: TaskWorkExecutor;
  controller: AbortController;
  completion: Promise<void>;
  stopping: boolean;
  stopPromise?: Promise<void>;
  outcome?: TaskWorkOutcome;
}

interface ClosedTask {
  floor: number;
  branchFloor: number;
  missing: boolean;
  confirmed: boolean;
  failed: boolean;
  completion: Promise<void>;
}

export function createTaskWorkManager(options: {
  store: TaskWorkStore;
  executionHostId: string;
  resolveMaxConcurrent: (context: TaskWorkContext) => Promise<number>;
  ownerId?: string;
  now?: () => string;
  onError?: (error: unknown) => void;
}): TaskWorkManager {
  const { store } = options;
  const ownerId = options.ownerId ?? randomUUID();
  const now = options.now ?? (() => new Date().toISOString());
  const report =
    options.onError ??
    ((error: unknown) =>
      console.error("[task-work] 后台工作生命周期失败：", error));
  const live = new Map<string, LiveWork>();
  const foreground = new Map<string, string>();
  const closedTasks = new Map<string, ClosedTask>();
  const waking = new Set<string>();
  const queues = new Map<string, Promise<unknown>>();
  const readyListeners = new Set<
    (identity: { instanceId: string; taskId: string }) => Promise<boolean>
  >();
  const changeListeners = new Set<(record: TaskWorkRecord) => Promise<void>>();
  let closed = false;
  let initialization: Promise<TaskWorkRecord[]> | undefined;
  let hostLease: TaskWorkHostLease | undefined;
  let closePromise: Promise<void> | undefined;
  const hostLossListeners = new Set<
    (event: TaskWorkHostLoss) => Promise<void>
  >();
  const keyOf = (instanceId: string, taskId: string) =>
    JSON.stringify([instanceId, taskId]);
  const keyFor = (context: TaskWorkContext) =>
    keyOf(context.scope.instanceId, context.scope.taskId);

  const serial = async <T>(
    key: string,
    action: () => Promise<T>,
  ): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    queues.set(key, current);
    try {
      return await current;
    } finally {
      if (queues.get(key) === current) queues.delete(key);
    }
  };
  const requireCurrent = async (context: TaskWorkContext) => {
    context.signal?.throwIfAborted();
    const fence = closedTasks.get(keyFor(context));
    if (
      closed ||
      !(await store.isCurrent(context)) ||
      (fence &&
        (fence.missing ||
          context.scope.generation <= fence.floor ||
          context.branchGeneration < fence.branchFloor))
    )
      throw new TaskWorkError(
        "task_closed",
        "Task 已关闭、授权已撤销或分支代际改变，拒绝迟到的后台操作。",
      );
    context.signal?.throwIfAborted();
    if (fence && !fence.confirmed)
      throw new TaskWorkError(
        "stop_unconfirmed",
        "旧 Task 的执行范围尚未确认停止，不能重开。",
      );
  };
  const initialize = () =>
    (initialization ??= (async () => {
      if (closed) throw new TaskWorkError("task_closed", "执行宿主已关闭。");
      const lease = await store.acquireHost(options.executionHostId, ownerId);
      if (!lease)
        throw new TaskWorkError(
          "execution_host_busy",
          "此执行宿主已有活实例，不能恢复或重复派发后台工作。",
        );
      hostLease = lease;
      const lost = () => {
        if (closed) return;
        closed = true;
        const taskKeys = new Set([
          ...foreground.keys(),
          ...[...live.values()].map((entry) => keyFor(entry.context)),
        ]);
        const tasks = [...taskKeys].map((key) => {
          const [instanceId, taskId]: [string, string] = JSON.parse(key);
          return { instanceId, taskId };
        });
        for (const listener of hostLossListeners)
          void Promise.resolve()
            .then(() =>
              listener({ executionHostId: options.executionHostId, tasks }),
            )
            .catch(report);
        void Promise.all(
          [...live].map(([id, entry]) =>
            stopEntry(id, entry, "执行宿主独占会话丢失"),
          ),
        ).catch(report);
      };
      lease.signal.addEventListener("abort", lost, { once: true });
      try {
        if (closed || lease.signal.aborted)
          throw new TaskWorkError(
            "execution_host_lost",
            "执行宿主独占会话已失效。",
          );
        const recovered = await store.interruptHost(
          options.executionHostId,
          ownerId,
          now(),
        );
        if (lease.signal.aborted)
          throw new TaskWorkError(
            "execution_host_lost",
            "执行宿主恢复期间失锁。",
          );
        for (const record of recovered) await publish(record);
        return recovered;
      } catch (error) {
        closed = true;
        await lease.release();
        throw error;
      }
    })());

  const wake = async (context: TaskWorkContext) => {
    const key = keyFor(context);
    const allowed = await serial(key, async () => {
      const fence = closedTasks.get(key);
      if (
        closed ||
        (fence &&
          (fence.missing ||
            !fence.confirmed ||
            context.scope.generation <= fence.floor)) ||
        foreground.has(key) ||
        waking.has(key) ||
        readyListeners.size === 0 ||
        !(await store.isCurrent(context, "notification"))
      )
        return false;
      const pending = (
        await store.list(context.scope.instanceId, context.scope.taskId)
      ).some(
        (record) =>
          record.detached &&
          record.branchGeneration === context.branchGeneration &&
          record.status !== "running" &&
          !record.consumed &&
          (!fence || record.scope.generation > fence.floor),
      );
      if (pending) waking.add(key);
      return pending;
    });
    if (!allowed) return;
    try {
      let admitted = false;
      for (const listener of readyListeners)
        if (
          await listener({
            instanceId: context.scope.instanceId,
            taskId: context.scope.taskId,
          })
        )
          admitted = true;
      if (!admitted) waking.delete(key);
    } catch (error) {
      waking.delete(key);
      report(error);
    }
  };

  const publish = async (record: TaskWorkRecord) => {
    for (const listener of changeListeners) {
      try {
        await listener(record);
      } catch (error) {
        report(error);
      }
    }
  };
  const settle = async (
    workId: string,
    entry: LiveWork,
    outcome: TaskWorkOutcome,
  ) => {
    const record = await serial(keyFor(entry.context), () =>
      store.settle(
        entry.context.scope.instanceId,
        entry.context.scope.taskId,
        workId,
        outcome,
        now(),
      ),
    );
    live.delete(workId);
    if (!record) return;
    // 数据先持久化，投影/通知失败不能改写工作真实终态。
    await publish(record);
    if (record.detached) await wake(entry.context);
  };

  const stopEntry = (
    workId: string,
    entry: LiveWork,
    reason: string,
  ): Promise<void> => {
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopping = true;
    entry.controller.abort(reason);
    entry.stopPromise = (async () => {
      try {
        await entry.executor.stop(reason);
        await entry.completion;
        await settle(workId, entry, {
          status: "canceled",
          summary: reason,
          ...(entry.outcome?.outputRef
            ? { outputRef: entry.outcome.outputRef }
            : {}),
          ...(entry.outcome?.outputStats
            ? { outputStats: entry.outcome.outputStats }
            : {}),
        });
      } catch (error) {
        // 停止失败仍保留 running；迟到的 run rejection 不能伪造取消/退出。
        // 后续显式请求可以再次确认，但并发请求必须加入同一次真实停止。
        delete entry.stopPromise;
        throw error;
      }
    })();
    return entry.stopPromise;
  };

  const launchAcceptedWork = (
    record: TaskWorkRecord,
    context: TaskWorkContext,
    executor: TaskWorkExecutor,
  ): void => {
    const entry: LiveWork = {
      context,
      executor,
      controller: new AbortController(),
      completion: Promise.resolve(),
      stopping: false,
    };
    live.set(record.id, entry);
    entry.completion = Promise.resolve()
      .then(async () => {
        await publish(record);
        return executor.run(entry.controller.signal);
      })
      .catch(
        (error: unknown): TaskWorkOutcome => ({
          status: entry.controller.signal.aborted ? "canceled" : "failed",
          summary: error instanceof Error ? error.message : String(error),
        }),
      )
      .then(async (outcome) => {
        entry.outcome = outcome;
        if (!entry.stopping) await settle(record.id, entry, outcome);
      });
    void entry.completion.catch(report);
  };

  return {
    initialize,
    async start(context, input, executor) {
      context.signal?.throwIfAborted();
      await initialize();
      return serial(keyFor(context), async () => {
        await requireCurrent(context);
        const records = await store.list(
          context.scope.instanceId,
          context.scope.taskId,
        );
        const detached = input.detached ?? true;
        const parameterFingerprint = fingerprintParameters({
          ...input,
          detached,
        });
        const previous = records.find(
          (record) =>
            record.originRunId === context.runId &&
            record.toolCallId === input.toolCallId &&
            record.branchGeneration === context.branchGeneration,
        );
        if (previous) {
          if (previous.parameterFingerprint !== parameterFingerprint)
            throw new TaskWorkError(
              "dispatch_conflict",
              "同一后台派发键不能使用不同参数。",
            );
          return previous;
        }
        const max = await options.resolveMaxConcurrent(context);
        if (
          records.filter((record) => record.status === "running").length >= max
        )
          throw new TaskWorkError(
            "concurrency_limit",
            `后台工作并发已满（上限 ${max}）；读取已有结果或停止不需要的工作后再派发。`,
          );
        const record: TaskWorkRecord = {
          id: randomUUID(),
          scope: structuredClone(context.scope),
          agentId: context.agentId,
          kind: input.kind,
          detached,
          label: input.label,
          originRunId: context.runId,
          toolCallId: input.toolCallId,
          parameterFingerprint,
          ...(input.childSessionId
            ? { childSessionId: input.childSessionId }
            : {}),
          branchGeneration: context.branchGeneration,
          status: "running",
          startedAt: now(),
          consumed: !detached,
          ownerId,
          executionHostId: options.executionHostId,
        };
        context.signal?.throwIfAborted();
        const created = await store.create(record);
        if (!created.created) {
          if (created.record.parameterFingerprint !== parameterFingerprint)
            throw new TaskWorkError(
              "dispatch_conflict",
              "同一后台派发键不能使用不同参数。",
            );
          return created.record;
        }
        launchAcceptedWork(record, context, executor);
        return created.record;
      });
    },
    async find(context, workId) {
      await initialize();
      return store.find(context.scope.instanceId, context.scope.taskId, workId);
    },
    async list(context) {
      await initialize();
      return store.list(context.scope.instanceId, context.scope.taskId);
    },
    async stop(context, workId, reason) {
      const record = await store.find(
        context.scope.instanceId,
        context.scope.taskId,
        workId,
      );
      if (!record)
        throw new TaskWorkError("work_not_found", "后台工作不属于当前 Task。");
      if (record.status !== "running") return;
      const entry = live.get(workId);
      if (!entry)
        throw new TaskWorkError(
          "stop_unconfirmed",
          "后台工作的执行句柄不可达，不能报告已停止。",
        );
      await stopEntry(workId, entry, reason);
    },
    async closeTask(instanceId, taskId, reason) {
      await initialize();
      const key = keyOf(instanceId, taskId);
      const closing = await serial(key, async () => {
        const authority = await store.closeFence(instanceId, taskId);
        // CodeUI beginClose/rewind 已推进 scope/branch；关闭墓碑属于被关闭的旧版本。
        const increment = authority?.state === "revoking" ? 1 : 0;
        const previous = closedTasks.get(key);
        const floor = Math.max(
          previous?.floor ?? 0,
          (authority?.scopeGeneration ?? 0) - increment,
        );
        const branchFloor = Math.max(
          previous?.branchFloor ?? 0,
          (authority?.branchGeneration ?? 0) - increment,
        );
        if (
          previous &&
          !previous.failed &&
          (!previous.confirmed ||
            (floor === previous.floor && branchFloor === previous.branchFloor))
        ) {
          previous.floor = floor;
          previous.branchFloor = branchFloor;
          return previous;
        }
        const state: ClosedTask = {
          floor,
          branchFloor,
          missing: authority === null,
          confirmed: false,
          failed: false,
          completion: Promise.resolve(),
        };
        closedTasks.set(key, state);
        waking.delete(key);
        state.completion = (async () => {
          const outcomes = await Promise.allSettled(
            [...live]
              .filter(([, entry]) => keyFor(entry.context) === key)
              .map(([id, entry]) => stopEntry(id, entry, reason)),
          );
          const failure = outcomes.find(
            (outcome) => outcome.status === "rejected",
          );
          if (failure?.status === "rejected") {
            state.failed = true;
            throw failure.reason;
          }
          state.confirmed = true;
        })();
        return state;
      });
      await closing.completion;
    },
    async enterForeground(context) {
      await initialize();
      const key = keyFor(context);
      await serial(key, async () => {
        await requireCurrent(context);
        if (foreground.has(key))
          throw new TaskWorkError(
            "foreground_busy",
            "同一 Task 已有前台 Run，不能并发启动另一轮。",
          );
        foreground.set(key, context.runId);
        waking.delete(key);
      });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await serial(key, async () => {
          if (foreground.get(key) === context.runId) foreground.delete(key);
        });
        await wake(context);
      };
    },
    async consumeNotifications(context) {
      const records = await serial(keyFor(context), async () => {
        await requireCurrent(context);
        return store.consume(context);
      });
      for (const record of records) await publish(record);
      const fence = closedTasks.get(keyFor(context));
      return records.filter(
        (record) =>
          record.detached && (!fence || record.scope.generation > fence.floor),
      );
    },
    async notifyReady(instanceId, taskId) {
      const records = await store.list(instanceId, taskId);
      for (const record of records.filter(
        (record) =>
          record.detached && record.status !== "running" && !record.consumed,
      )) {
        await wake({
          scope: record.scope,
          agentId: record.agentId,
          runId: record.originRunId,
          branchGeneration: record.branchGeneration,
        });
      }
    },
    async recordOutput(context, workId, outputRef, stats) {
      await store.updateOutput(
        context.scope.instanceId,
        context.scope.taskId,
        workId,
        ownerId,
        outputRef,
        stats,
      );
    },
    onReady(listener) {
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    onHostLost(listener) {
      hostLossListeners.add(listener);
      return () => {
        hostLossListeners.delete(listener);
      };
    },
    onChanged(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    async close(reason) {
      closed = true;
      closePromise ??= (async () => {
        await initialization?.catch(() => {});
        const results = await Promise.allSettled(
          [...live].map(([id, entry]) => stopEntry(id, entry, reason)),
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          closePromise = undefined;
          throw failure.reason;
        }
        await hostLease?.release();
      })();
      return closePromise;
    },
  };
}
