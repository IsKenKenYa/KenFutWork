import { randomUUID } from "node:crypto";
import type {
  PersistenceService,
  PersistenceSessionLock,
} from "../persistence/types.js";
import type { DesignGoalLifecycle } from "./design-goals-types.js";
import { DesignTaskError } from "./design-task-errors.js";
import { loadDesignTask } from "./design-task-metadata.js";

/** A dedicated PostgreSQL session proves ownership; time alone never proves host death. */
export function createDesignTaskLeases(
  persistence: PersistenceService,
  goals?: DesignGoalLifecycle,
) {
  const ownerId = randomUUID();
  const locks = new Map<string, Promise<PersistenceSessionLock | null>>();
  const operations = new Map<string, Promise<void>>();
  const listeners = new Set<(instanceId: string, taskId: string) => void>();
  const keyFor = (instanceId: string, taskId: string) =>
    `${instanceId}:${taskId}`;
  async function acquire(instanceId: string, taskId: string): Promise<boolean> {
    const key = keyFor(instanceId, taskId);
    let pending = locks.get(key);
    if (!pending) {
      const readiness = (async () => {
        const lock = await persistence.acquireSessionLock(`design-task:${key}`);
        if (!lock) return null;
        try {
          await persistence.transaction(async (tx) => {
            if (lock.signal.aborted)
              throw new DesignTaskError(
                "design_task_lease_lost",
                "任务运行进程已断开",
              );
            const sql = tx.forInstance(instanceId);
            const task = await loadDesignTask(sql, taskId, true);
            if (!task)
              throw new DesignTaskError(
                "design_task_unavailable",
                "任务执行信息不可用",
              );
            if (task.active_run_id || task.restore_operation_id)
              await goals?.recover(sql, task, Date.now());
            if (task.active_run_id) {
              const run = await sql.queryOne<{ status: string }>(
                `select r.status from public.agent_runs r join public.chat_sessions c on c.id=r.session_id
                where c.instance_id=:instance and c.id=$1 and r.id=$2 for update of r`,
                [taskId, task.active_run_id],
              );
              const terminal =
                run?.status === "completed" ||
                run?.status === "canceled" ||
                run?.status === "failed";
              if (run && !terminal) {
                await sql.execute(
                  `update public.agent_runs r set status='failed',completed_at=now(),
                error_code='runtime_interrupted',error_message='运行已中断，请重试'
                from public.chat_sessions c where c.instance_id=:instance and c.id=$1
                  and r.session_id=c.id and r.id=$2 and r.status in ('accepted','running')`,
                  [taskId, task.active_run_id],
                );
              }
              await sql.execute(
                `update public.design_task_inputs set status='settled',request=null
              where instance_id=:instance and task_id=$1 and run_id=$2 and status='running'`,
                [taskId, task.active_run_id],
              );
              await sql.execute(
                `update public.design_task_executions set active_run_id=null,run_state='idle',
              last_settled_run_id=$2,last_run_outcome=$3 where instance_id=:instance and task_id=$1`,
                [taskId, task.active_run_id, terminal ? run!.status : "failed"],
              );
            }
            if (task.restore_operation_id)
              await sql.execute(
                `update public.design_task_executions set restore_operation_id=null,execution_state='failed'
               where instance_id=:instance and task_id=$1 and restore_operation_id=$2`,
                [taskId, task.restore_operation_id],
              );
            await sql.execute(
              `update public.design_task_executions set runtime_owner_id=$2
            where instance_id=:instance and task_id=$1`,
              [taskId, ownerId],
            );
            if (lock.signal.aborted)
              throw new DesignTaskError(
                "design_task_lease_lost",
                "任务运行进程已断开",
              );
          });
          lock.signal.addEventListener(
            "abort",
            () => {
              if (locks.get(key) !== pending) return;
              locks.delete(key);
              for (const notify of listeners) notify(instanceId, taskId);
            },
            { once: true },
          );
          if (lock.signal.aborted) return null;
          return lock;
        } catch (error) {
          await lock.release();
          throw error;
        }
      })();
      pending = readiness;
      locks.set(key, readiness);
    }
    try {
      const lock = await pending;
      if (!lock || lock.signal.aborted) {
        locks.delete(key);
        return false;
      }
      return true;
    } catch (error) {
      locks.delete(key);
      throw error;
    }
  }
  return {
    acquire,
    async withTask<T>(
      instanceId: string,
      taskId: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      const key = keyFor(instanceId, taskId);
      const previous = operations.get(key) ?? Promise.resolve();
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const queued = previous.then(() => gate);
      operations.set(key, queued);
      await previous;
      try {
        return await fn();
      } finally {
        try {
          if (locks.has(key)) {
            const sql = persistence.forInstance(instanceId);
            const task = await loadDesignTask(sql, taskId);
            const pending =
              task &&
              (await sql.queryOne(
                `select input_id from public.design_task_inputs
              where instance_id=:instance and task_id=$1 and status='queued' limit 1`,
                [taskId],
              ));
            if (
              !task ||
              (!task.active_run_id && !pending && !task.restore_operation_id)
            ) {
              const lock = locks.get(key);
              locks.delete(key);
              await (await lock)?.release();
            }
          }
        } finally {
          finish();
          if (operations.get(key) === queued) operations.delete(key);
        }
      }
    },
    ownerId,
    onLost(listener: (instanceId: string, taskId: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async release(instanceId: string, taskId: string) {
      const key = keyFor(instanceId, taskId);
      const pending = locks.get(key);
      locks.delete(key);
      await (await pending)?.release();
    },
    async close() {
      const pending = [...locks.values()];
      locks.clear();
      for (const value of pending) await (await value)?.release();
    },
  };
}
